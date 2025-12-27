// /pages/api/area.js  (Next.js / Vercel)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD = "2025-12-27-FULL-01";

  const address = (req.query.address || "").trim();
  const floor = String(req.query.floor || "").trim(); // 층은 필수(현재 구조)
  const hoInput = (req.query.ho || "").trim();        // 선택

  if (!address || !floor) {
    return res.status(400).json({ ok: false, build: BUILD, message: "address와 floor는 필수입니다." });
  }

  try {
    // ------------------------------------------------------------
    // 1) JUSO 주소 → 지번(행정코드)
    // ------------------------------------------------------------
    const jusoUrl = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
    jusoUrl.searchParams.set("confmKey", process.env.JUSO_KEY);
    jusoUrl.searchParams.set("currentPage", "1");
    jusoUrl.searchParams.set("countPerPage", "10");
    jusoUrl.searchParams.set("keyword", address);
    jusoUrl.searchParams.set("resultType", "json");

    const jusoRes = await fetch(jusoUrl.toString());
    const jusoData = await jusoRes.json();
    const jusoList = jusoData?.results?.juso || [];
    if (!jusoList.length) throw new Error("주소 검색 결과가 없습니다.");

    const j = jusoList[0];
    const admCd = j.admCd;

    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd = admCd.slice(5, 10);
    const bun = String(j.lnbrMnnm).padStart(4, "0");
    const ji = String(j.lnbrSlno).padStart(4, "0");

    const baseKeys = { sigunguCd, bjdongCd, bun, ji };

    // ------------------------------------------------------------
    // 2) 층별현황: getBrFlrOulnInfo → 같은 층 item 여러개 나올 수 있음
    //     => "floor_items" 배열로 전부 반환 + pick(추천)
    // ------------------------------------------------------------
    const flrUrl = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrFlrOulnInfo");
    flrUrl.searchParams.set("serviceKey", process.env.BLD_KEY);
    flrUrl.searchParams.set("sigunguCd", sigunguCd);
    flrUrl.searchParams.set("bjdongCd", bjdongCd);
    flrUrl.searchParams.set("bun", bun);
    flrUrl.searchParams.set("ji", ji);
    flrUrl.searchParams.set("numOfRows", "9999");
    flrUrl.searchParams.set("pageNo", "1");

    const flrXml = await (await fetch(flrUrl.toString())).text();
    assertApiOk(flrXml, "getBrFlrOulnInfo");

    const flrItems = parseItems(flrXml).map(itemXmlToObj);

    // 해당 floor만 필터
    const floorItems = flrItems.filter(it => String(it.flrNo || "") === String(floor));

    // pick 규칙: (1) 공용시설 같은 것보다 “업무/주용도” 느낌을 우선,
    //          (2) 그래도 모르겠으면 area 큰 것 우선
    const pick = pickBestFloorItem(floorItems);

    // ------------------------------------------------------------
    // 3) 호별 요청이 없으면: 층 item 목록 + pick + ho_list(드롭다운용)
    // ------------------------------------------------------------
    if (!hoInput) {
      // (A) 층 item이 없는 경우도 호목록은 있을 수 있으니, floor_items는 그대로
      let hoList = [];
      let hoNote = "";
    
      try {
        // 해당 주소 전체 전유부 목록 → floor만 필터 → hoNm 모으기
        const exposUrl = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposInfo");
        exposUrl.searchParams.set("serviceKey", process.env.BLD_KEY);
        exposUrl.searchParams.set("sigunguCd", sigunguCd);
        exposUrl.searchParams.set("bjdongCd", bjdongCd);
        exposUrl.searchParams.set("bun", bun);
        exposUrl.searchParams.set("ji", ji);
        exposUrl.searchParams.set("numOfRows", "9999");
        exposUrl.searchParams.set("pageNo", "1");
    
        const exposXml = await (await fetch(exposUrl.toString())).text();
        assertApiOk(exposXml, "getBrExposInfo");
    
        const exposItems = parseItems(exposXml).map(itemXmlToObj);
    
        // 층 필터 + hoNm 수집
        const rawHos = exposItems
          .filter(it => String(it.flrNo || "") === String(floor))
          .map(it => (it.hoNm || "").trim())
          .filter(Boolean);
    
        // 중복 제거 + 정렬(숫자 기준)
        const uniq = [...new Set(rawHos)];
        hoList = uniq.sort((a, b) => {
          const na = Number(normalizeHo(a)) || 0;
          const nb = Number(normalizeHo(b)) || 0;
          if (na !== nb) return na - nb;
          return a.localeCompare(b, "ko");
        });
    
        if (!hoList.length) hoNote = "해당 층에서 호 목록을 찾지 못했습니다.";
      } catch (e) {
        // 호 목록 조회 실패해도 층 면적은 보여주도록, note만 남김
        hoNote = `호 목록 조회 실패: ${e.message}`;
      }
    
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floorItems+hoList",
        input: { address, floor, ho: null },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        floor_items: floorItems.map(toClientFloorItem),
        pick: pick ? toClientFloorItem(pick) : null,
        ho_list: hoList,          // ✅ 프론트 드롭다운에 바로 씀
        ho_list_note: hoNote,     // ✅ 안 나오면 이유 표시용
      });
    }

    // ------------------------------------------------------------
    // 4) 호별 면적: (A) getBrExposInfo (전유부 조회)에서 먼저 찾기
    //    - 여기 응답에도 area가 들어오는 케이스가 많음(문서 예시도 area)
    // ------------------------------------------------------------
    const wantHoNorm = normalizeHo(hoInput); // "1209", "1209호", "1209-1" => "1209"
    const exposUrl = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposInfo");
    exposUrl.searchParams.set("serviceKey", process.env.BLD_KEY);
    exposUrl.searchParams.set("sigunguCd", sigunguCd);
    exposUrl.searchParams.set("bjdongCd", bjdongCd);
    exposUrl.searchParams.set("bun", bun);
    exposUrl.searchParams.set("ji", ji);
    exposUrl.searchParams.set("numOfRows", "9999");
    exposUrl.searchParams.set("pageNo", "1");

    const exposXml = await (await fetch(exposUrl.toString())).text();
    assertApiOk(exposXml, "getBrExposInfo");

    const exposItems = parseItems(exposXml).map(itemXmlToObj);

    // 같은 층 + ho 매칭(숫자정규화)
    let target = exposItems.find(it =>
      String(it.flrNo || "") === String(floor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm
    );

    // area 후보 (문서에도 area가 존재)  :contentReference[oaicite:3]{index=3}
    let areaM2 = target ? toNumber(target.area) : 0;

    if (areaM2 > 0) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "exposInfo(전유부) ho-match",
        input: { address, floor, ho: hoInput },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        ho_matched: { hoNm: target.hoNm, flrNo: target.flrNo, dongNm: target.dongNm || "" },
        area_m2: areaM2,
        area_pyeong: round2(areaM2 / 3.305785),
      });
    }

    // ------------------------------------------------------------
    // 5) (B) getBrExposPubuseAreaInfo에서 전유(1)로 찾기 (호별/전유/공용)
    //    - 면적 태그는 area :contentReference[oaicite:4]{index=4}
    // ------------------------------------------------------------
    const pubUrl = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo");
    pubUrl.searchParams.set("serviceKey", process.env.BLD_KEY);
    pubUrl.searchParams.set("sigunguCd", sigunguCd);
    pubUrl.searchParams.set("bjdongCd", bjdongCd);
    pubUrl.searchParams.set("bun", bun);
    pubUrl.searchParams.set("ji", ji);
    pubUrl.searchParams.set("numOfRows", "9999");
    pubUrl.searchParams.set("pageNo", "1");

    const pubXml = await (await fetch(pubUrl.toString())).text();
    assertApiOk(pubXml, "getBrExposPubuseAreaInfo");

    const pubItems = parseItems(pubXml).map(itemXmlToObj);

    // 전유만(1) + 층 + 호
    target = pubItems.find(it =>
      String(it.flrNo || "") === String(floor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm &&
      (String(it.exposPubuseGbCd || "") === "1" || (it.exposPubuseGbCdNm || "").includes("전유"))
    );

    areaM2 = target ? toNumber(target.area) : 0;

    if (areaM2 > 0) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "exposPubuseArea(전유/공용) ho-match",
        input: { address, floor, ho: hoInput },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        ho_matched: { hoNm: target.hoNm, flrNo: target.flrNo, dongNm: target.dongNm || "" },
        area_m2: areaM2,
        area_pyeong: round2(areaM2 / 3.305785),
      });
    }

    // ------------------------------------------------------------
    // 6) 그래도 못 찾으면: debug용으로 그 층의 hoNm 샘플을 내려줌
    // ------------------------------------------------------------
    const hoSamples = pubItems
      .filter(it => String(it.flrNo || "") === String(floor))
      .slice(0, 50)
      .map(it => it.hoNm)
      .filter(Boolean);

    return res.status(404).json({
      ok: false,
      build: BUILD,
      message: "전유부/전유공용면적 조회에서 해당 층/호 전유면적을 찾지 못했습니다. (hoNm 표기 형식 확인 필요)",
      input: { address, floor, ho: hoInput },
      wantHoNorm,
      hoNmSamples: hoSamples,
      note: "예: '1209', '1209호', '1209-1' 등으로 다를 수 있어 숫자만 비교하도록 구현했습니다.",
    });

  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message, build: "2025-12-27-FULL-01" });
  }
}

/* ----------------- helpers ----------------- */

function getTag(xmlChunk, tag) {
  const m = xmlChunk.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}

function parseItems(xmlText) {
  return [...xmlText.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}

// XML item -> JS obj (필요한 필드는 넉넉히)
function itemXmlToObj(item) {
  const tags = [
    "flrNo", "flrNoNm", "flrGbCdNm",
    "hoNm", "dongNm",
    "exposPubuseGbCd", "exposPubuseGbCdNm",
    "mainPurpsCdNm", "etcPurps",
    "area",
    "mgmBldrgstPk"
  ];
  const o = {};
  for (const t of tags) o[t] = getTag(item, t);
  return o;
}

function toNumber(v) {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Number(Number(n).toFixed(2));
}

function normalizeHo(s) {
  // "1209호", "1209", "1209-1" => "1209" (앞 숫자만)
  const m = String(s || "").match(/\d+/);
  return m ? m[0] : "";
}

function pickBestFloorItem(items) {
  if (!items || !items.length) return null;

  // 공용시설/공용 같은 키워드가 있는 item은 우선순위를 낮춤
  const score = (it) => {
    const area = toNumber(it.area);
    const txt = `${it.mainPurpsCdNm || ""} ${it.etcPurps || ""}`.trim();
    let s = area;

    // "공용"이 들어가면 감점, "업무/사무" 느낌이면 가점
    if (txt.includes("공용")) s -= 100000;
    if (txt.includes("업무") || txt.includes("사무")) s += 50000;

    return s;
  };

  return [...items].sort((a, b) => score(b) - score(a))[0];
}

function toClientFloorItem(it) {
  const areaM2 = toNumber(it.area);
  return {
    flrNo: it.flrNo || "",
    flrNoNm: it.flrNoNm || "",
    flrGbCdNm: it.flrGbCdNm || "",
    mainPurpsCdNm: it.mainPurpsCdNm || "",
    etcPurps: it.etcPurps || "",
    area_m2: areaM2,
    area_pyeong: round2(areaM2 / 3.305785),
  };
}

function assertApiOk(xmlText, apiName) {
  const resultCode = xmlText.match(/<resultCode>(.*?)<\/resultCode>/)?.[1]?.trim() || "";
  const resultMsg  = xmlText.match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1]?.trim() || "";
  if (resultCode && resultCode !== "00") {
    throw new Error(`${apiName} 호출 실패: ${resultCode} ${resultMsg}`);
  }
  if ((xmlText || "").includes("API not found")) {
    throw new Error(`${apiName} 호출 실패: API not found (엔드포인트 경로 확인 필요)`);
  }
}
