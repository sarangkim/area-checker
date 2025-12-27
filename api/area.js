// api/area.js
// 주소 + 층(+선택: 호) → 전유면적(㎡) + 평
// 디버그 포함 버전 (배포/응답 원인 즉시 확인)

const BUILD = "2025-12-27-02"; // 배포가 반영됐는지 확인용(원하면 숫자만 바꿔도 됨)

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const address = (req.query.address || "").trim();
  const floor = String(req.query.floor || "").trim();
  const hoInput = (req.query.ho || "").trim(); // 선택: 501 또는 501호

  if (!address || !floor) {
    return res.status(400).json({
      ok: false,
      build: BUILD,
      message: "address와 floor는 필수입니다. 예) ?address=서울...&floor=5",
    });
  }

  try {
    /* =========================
       1) JUSO 주소 → 지번(행정코드/본번/부번)
    ========================= */
    const jusoUrl = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
    jusoUrl.searchParams.set("confmKey", process.env.JUSO_KEY);
    jusoUrl.searchParams.set("currentPage", "1");
    jusoUrl.searchParams.set("countPerPage", "10");
    jusoUrl.searchParams.set("keyword", address);
    jusoUrl.searchParams.set("resultType", "json");

    const jusoRes = await fetch(jusoUrl.toString());
    const jusoData = await jusoRes.json();
    const jusoList = jusoData?.results?.juso || [];
    if (!jusoList.length) {
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "주소 검색 결과가 없습니다(JUSO).",
        debug: { address },
      });
    }

    // 첫 번째 결과 사용(필요하면 나중에 정확매칭 로직 추가 가능)
    const j = jusoList[0];
    const admCd = j.admCd || "";
    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd = admCd.slice(5, 10);
    const bun = String(j.lnbrMnnm).padStart(4, "0");
    const ji = String(j.lnbrSlno).padStart(4, "0");

    if (!sigunguCd || !bjdongCd) {
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "JUSO 결과에서 행정코드(admCd)를 파싱하지 못했습니다.",
        debug: { admCd, j },
      });
    }

    /* =========================
       2) 전유부(호별) 목록 조회: getBrExposInfo
       - 여기서는 면적이 없고, mgmBldrgstPk(관리건축물대장PK)를 얻기 위함
    ========================= */
    const exposUrl = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposInfo");
    exposUrl.searchParams.set("serviceKey", process.env.BLD_KEY);
    exposUrl.searchParams.set("sigunguCd", sigunguCd);
    exposUrl.searchParams.set("bjdongCd", bjdongCd);
    exposUrl.searchParams.set("bun", bun);
    exposUrl.searchParams.set("ji", ji);
    exposUrl.searchParams.set("numOfRows", "5000");
    exposUrl.searchParams.set("pageNo", "1");

    const exposRes = await fetch(exposUrl.toString());
    const exposXml = await exposRes.text();

    const exposTotal = exposXml.match(/<totalCount>(\d+)<\/totalCount>/)?.[1] || "";
    const exposCode = exposXml.match(/<resultCode>(.*?)<\/resultCode>/)?.[1]?.trim() || "";
    const exposMsg  = exposXml.match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1]?.trim() || "";

    const exposItems = [...exposXml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    if (!exposItems.length) {
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "전유부(호별) 목록이 없습니다(getBrExposInfo).",
        debug: {
          sigunguCd, bjdongCd, bun, ji,
          expos: { exposTotal, exposCode, exposMsg },
          exposXmlHead: exposXml.slice(0, 600),
        },
      });
    }

    const wantHo = hoInput
      ? (hoInput.endsWith("호") ? hoInput : `${hoInput}호`)
      : null;

    // 층/호 매칭
    const target = exposItems.find(it => {
      const flrNo = getTag(it, "flrNo");
      const hoNm = getTag(it, "hoNm");
      if (String(flrNo) !== String(floor)) return false;
      if (wantHo && hoNm !== wantHo) return false;
      return true;
    });

    if (!target) {
      // 해당 층에서 어떤 호들이 있는지 같이 보여주면 디버깅 쉬움
      const floorHos = exposItems
        .filter(it => String(getTag(it, "flrNo")) === String(floor))
        .slice(0, 50)
        .map(it => getTag(it, "hoNm"))
        .filter(Boolean);

      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "해당 층/호를 전유부 목록에서 찾지 못했습니다.",
        debug: { floor, wantHo, sampleHosOnThatFloor: floorHos },
      });
    }

    const mgmBldrgstPk = getTag(target, "mgmBldrgstPk");
    if (!mgmBldrgstPk) {
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "전유부 목록 item에 mgmBldrgstPk(관리건축물대장PK)가 없습니다.",
        debugItemRaw: target.slice(0, 800),
      });
    }

    /* =========================
       3) 전유부 '기본정보(상세)' 조회: getBrBasisOulnInfo
       - 여기서 전유면적(excluUseAr)이 나오는 게 정석
       - 주의: mgmBldrgstPk + 지번 파라미터까지 같이 넣어봄
    ========================= */
    const detailUrl = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrBasisOulnInfo");
    detailUrl.searchParams.set("serviceKey", process.env.BLD_KEY);
    detailUrl.searchParams.set("mgmBldrgstPk", mgmBldrgstPk);

    // 지번 파라미터도 같이 (서비스/버전마다 요구하는 케이스가 있어 포함)
    detailUrl.searchParams.set("sigunguCd", sigunguCd);
    detailUrl.searchParams.set("bjdongCd", bjdongCd);
    detailUrl.searchParams.set("bun", bun);
    detailUrl.searchParams.set("ji", ji);

    detailUrl.searchParams.set("numOfRows", "10");
    detailUrl.searchParams.set("pageNo", "1");

    const detailRes = await fetch(detailUrl.toString());
    const detailXml = await detailRes.text();

    const totalCount = detailXml.match(/<totalCount>(\d+)<\/totalCount>/)?.[1] || "";
    const resultCode = detailXml.match(/<resultCode>(.*?)<\/resultCode>/)?.[1]?.trim() || "";
    const resultMsg  = detailXml.match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1]?.trim() || "";

    const detailItem = detailXml.match(/<item>([\s\S]*?)<\/item>/)?.[1];

    if (!detailItem) {
      const safeUrl = detailUrl.toString().replace(process.env.BLD_KEY, "SERVICE_KEY_HIDDEN");
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "전유부 상세 정보가 없습니다(getBrBasisOulnInfo).",
        detailDebug: { totalCount, resultCode, resultMsg, safeUrl, mgmBldrgstPk },
        detailXmlHead: detailXml.slice(0, 900),
      });
    }

    // 면적 태그 후보 자동 탐지
    const areaCandidates = ["excluUseAr", "area", "totArea", "totAr"];
    let areaM2 = 0;
    let pickedTag = "";

    for (const t of areaCandidates) {
      const v = detailItem.match(new RegExp(`<${t}>([\\d.]+)<\\/${t}>`))?.[1];
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        areaM2 = n;
        pickedTag = t;
        break;
      }
    }

    if (!areaM2) {
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "상세 item은 있는데 면적 태그를 못 찾았습니다(필드명 차이 가능).",
        found: Object.fromEntries(
          areaCandidates.map(t => [
            t,
            (detailItem.match(new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`))?.[1] || "")
          ])
        ),
        detailItemHead: detailItem.slice(0, 900),
      });
    }

    const areaPyeong = areaM2 / 3.305785;

    return res.status(200).json({
      ok: true,
      build: BUILD,
      address,
      jibun: j.jibunAddr,
      road: j.roadAddr,
      floor,
      ho: wantHo || null,
      mgmBldrgstPk,
      area_m2: areaM2,
      area_pyeong: Number(areaPyeong.toFixed(2)),
      picked_area_tag: pickedTag,
      source: "건축HUB getBrExposInfo → getBrBasisOulnInfo",
    });

  } catch (e) {
    return res.status(500).json({ ok: false, build: BUILD, message: e.message });
  }
}

function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}
