// api/area.js
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD = "2025-12-27-03";

  const address = (req.query.address || "").trim(); // 도로명/지번 아무거나
  const floor = String(req.query.floor || "").trim(); // 예: 5
  const hoInput = (req.query.ho || "").trim(); // 예: 501 or 501호 (옵션)

  if (!address || !floor) {
    return res.status(400).json({ ok: false, message: "address와 floor는 필수입니다." });
  }

  try {
    // =========================
    // 1) 주소 → 지번 파싱 (JUSO 검색 API)
    // =========================
    const jusoUrl = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
    jusoUrl.searchParams.set("confmKey", process.env.JUSO_KEY); // confmKey
    jusoUrl.searchParams.set("currentPage", "1");
    jusoUrl.searchParams.set("countPerPage", "10");
    jusoUrl.searchParams.set("keyword", address);
    jusoUrl.searchParams.set("resultType", "json");

    const jusoRes = await fetch(jusoUrl.toString());
    const jusoData = await jusoRes.json();
    const jusoList = jusoData?.results?.juso || [];
    if (!jusoList.length) throw new Error("주소 검색 결과가 없습니다. (JUSO)");

    const j = jusoList[0];

    // admCd: 시군구(5) + 법정동(5)
    const admCd = j.admCd || "";
    if (admCd.length < 10) throw new Error("JUSO 응답에서 admCd가 비정상입니다.");

    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd = admCd.slice(5, 10);
    const bun = String(j.lnbrMnnm).padStart(4, "0");
    const ji = String(j.lnbrSlno).padStart(4, "0");

    // =========================
    // 2) 전유부 목록 조회: getBrExposInfo
    //    - 여기에는 면적이 없을 수 있음 (지금 너 케이스처럼)
    //    - 대신 mgmBldrgstPk(관리전유부대장PK)를 얻기 위한 단계
    // =========================
    const listUrl = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposInfo");
    listUrl.searchParams.set("serviceKey", process.env.BLD_KEY); // serviceKey
    listUrl.searchParams.set("sigunguCd", sigunguCd);
    listUrl.searchParams.set("bjdongCd", bjdongCd);
    listUrl.searchParams.set("bun", bun);
    listUrl.searchParams.set("ji", ji);
    listUrl.searchParams.set("numOfRows", "5000");
    listUrl.searchParams.set("pageNo", "1");

    const listRes = await fetch(listUrl.toString());
    const listXml = await listRes.text();

    const listItems = [...listXml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    if (!listItems.length) {
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "전유부(호별) 목록 데이터가 없습니다. (getBrExposInfo)",
        debug: safeDebug(listUrl, listXml, process.env.BLD_KEY),
      });
    }

    const wantHo = hoInput
      ? (hoInput.endsWith("호") ? hoInput : `${hoInput}호`)
      : null;

    // 층/호로 대상 찾기
    const picked = listItems.find(it => {
      const flrNo = getTag(it, "flrNo");   // 예: 5
      const hoNm = getTag(it, "hoNm");     // 예: 501호
      if (String(flrNo) !== String(floor)) return false;
      if (wantHo && hoNm !== wantHo) return false;
      return true;
    });

    if (!picked) {
      return res.status(404).json({
        ok: false,
        build: BUILD,
        message: "해당 층/호를 전유부 목록에서 찾지 못했습니다. (floor/ho 확인)",
        debug: {
          floor, hoInput, wantHo,
          sampleHos: listItems.slice(0, 10).map(x => ({
            flrNo: getTag(x, "flrNo"),
            hoNm: getTag(x, "hoNm"),
          })),
        },
      });
    }

    const mgmBldrgstPk = getTag(picked, "mgmBldrgstPk"); // 관리전유부대장PK (핵심)
    if (!mgmBldrgstPk) {
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "전유부 목록 item에 mgmBldrgstPk가 없습니다. (상세조회 키 누락)",
        debugItemRaw: picked.slice(0, 1200),
      });
    }

    // =========================
    // 3) 전유부 상세 조회: getBrExposOulnInfo
    //    - 여기에서 면적 태그가 나오는 경우가 많음
    // =========================
    const detailUrl = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposOulnInfo");
    detailUrl.searchParams.set("serviceKey", process.env.BLD_KEY);
    detailUrl.searchParams.set("sigunguCd", sigunguCd);
    detailUrl.searchParams.set("bjdongCd", bjdongCd);
    detailUrl.searchParams.set("bun", bun);
    detailUrl.searchParams.set("ji", ji);
    detailUrl.searchParams.set("mgmBldrgstPk", mgmBldrgstPk);
    detailUrl.searchParams.set("numOfRows", "100");
    detailUrl.searchParams.set("pageNo", "1");

    const detailRes = await fetch(detailUrl.toString());
    const detailXml = await detailRes.text();

    // 응답 상태 확인(디버그용)
    const totalCount = detailXml.match(/<totalCount>(\d+)<\/totalCount>/)?.[1] || "";
    const resultCode = detailXml.match(/<resultCode>(.*?)<\/resultCode>/)?.[1]?.trim() || "";
    const resultMsg  = detailXml.match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1]?.trim() || "";

    const detailItem = detailXml.match(/<item>([\s\S]*?)<\/item>/)?.[1];
    if (!detailItem) {
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "전유부 상세 정보 item이 없습니다. (getBrExposOulnInfo)",
        detailDebug: {
          totalCount, resultCode, resultMsg,
          safeUrl: detailUrl.toString().replace(process.env.BLD_KEY, "SERVICE_KEY_HIDDEN"),
          mgmBldrgstPk,
        },
        detailXmlHead: detailXml.slice(0, 800),
      });
    }

    // =========================
    // 4) 면적 태그 자동 탐색
    // =========================
    const areaM2 = findAreaM2(detailItem);

    if (!areaM2) {
      // 어떤 태그가 있는지 빠르게 확인할 수 있도록 tag 목록/샘플 내려줌
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "상세 item은 있는데 면적 태그를 못 찾았습니다. (필드명 차이 가능)",
        foundCandidates: extractCandidates(detailItem),
        detailItemHead: detailItem.slice(0, 1200),
      });
    }

    const areaPyeong = areaM2 / 3.305785;

    return res.status(200).json({
      ok: true,
      build: BUILD,
      input: { address, floor, ho: hoInput || null },
      jibun: j.jibunAddr,
      road: j.roadAddrPart1,
      picked: {
        hoNm: getTag(picked, "hoNm"),
        flrNo: getTag(picked, "flrNo"),
        mgmBldrgstPk,
      },
      area_m2: Number(areaM2),
      area_pyeong: Number(areaPyeong.toFixed(2)),
      source: "getBrExposInfo → getBrExposOulnInfo",
    });

  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

// ---------- utils ----------
function getTag(xmlChunk, tag) {
  const m = xmlChunk.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}

function findAreaM2(itemXml) {
  // 문서/버전에 따라 필드명이 바뀌는 경우가 있어 후보를 넓게 둠
  const candidates = [
    "excluUseAr",     // 전유면적(가장 흔한 편)
    "area",           // 일부 서비스에서 area
    "archArea",       // 건축면적
    "totArea",        // 연면적
    "totAr",
    "flrArea",
    "useAprDayAr",    // (혹시 다른 명칭)
    "prvuseArea",     // 전유/사유 면적류
    "prvUseAr",
  ];

  for (const t of candidates) {
    const v = getTag(itemXml, t);
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }

  // 숫자형으로 보이는 태그들을 추가 스캔(“면적”이라는 단어 포함 태그)
  // 예: <xxxAr>12.34</xxxAr> 류
  const allAreaLike = [...itemXml.matchAll(/<([a-zA-Z0-9_]+)>([\d.]+)<\/\1>/g)]
    .map(m => ({ tag: m[1], val: m[2] }))
    .filter(x => /ar|area|Ar|Area/.test(x.tag));

  for (const x of allAreaLike) {
    const n = Number(x.val);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return 0;
}

function extractCandidates(itemXml) {
  // item에 실제 어떤 태그가 있는지 보고 싶을 때
  const pairs = [...itemXml.matchAll(/<([a-zA-Z0-9_]+)>([\\s\\S]*?)<\/\1>/g)]
    .slice(0, 80) // 너무 길어지면 보기 힘드니 앞부분만
    .map(m => [m[1], m[2].trim().slice(0, 80)]);
  return Object.fromEntries(pairs);
}

function safeDebug(urlObj, xmlText, secret) {
  return {
    safeUrl: urlObj.toString().replace(secret, "SERVICE_KEY_HIDDEN"),
    xmlHead: xmlText.slice(0, 800),
  };
}
