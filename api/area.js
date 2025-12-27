// /pages/api/area.js  (Next.js / Vercel)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD = "2025-12-27-FIX-HO-FALLBACK-01";

  const address = (req.query.address || "").trim();
  const floorRaw = (req.query.floor || "").toString().trim(); // floor는 선택(아래에서 처리)
  const hoInput = (req.query.ho || "").trim();                // 선택

  if (!address) {
    return res.status(400).json({ ok: false, build: BUILD, message: "address는 필수입니다." });
  }

  // "12층" 같은 값 들어오면 숫자만 뽑아서 사용
  const floor = normalizeFloor(floorRaw); // "" or "12"

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
    // 2) 층별현황: getBrFlrOulnInfo (전체)
    //   - floor가 없으면: "층 목록만" 내려줘서 프론트가 버튼 만들게 함
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
    const flrItemsAll = parseItems(flrXml).map(itemXmlToObj);

    // 층 목록(실제 존재 층만)
    const floors = buildFloorsFromFlrItems(flrItemsAll);

    // floor 없이 호출한 경우: 층 목록 + 요약만 반환
    if (!floor) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floorsOnly",
        input: { address, floor: null, ho: null },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        floors, // ✅ 프론트가 이걸로 버튼 생성
        note: "floor 없이 호출되어 층 목록만 반환했습니다. 층을 선택해 다시 호출하세요.",
      });
    }

    // ------------------------------------------------------------
    // 3) 선택된 층의 item들 (같은 층 item 여러개 가능)
    // ------------------------------------------------------------
    const floorItems = flrItemsAll.filter(it => String(it.flrNo || "") === String(floor));
    const pick = pickBestFloorItem(floorItems);

    // ------------------------------------------------------------
    // 4) 호 목록: getBrExposInfo에서 해당 층 hoNm 수집
    // ------------------------------------------------------------
    let hoList = [];
    let hoNote = "";

    try {
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

      const rawHos = exposItems
        .filter(it => String(it.flrNo || "") === String(floor))
        .map(it => (it.hoNm || "").trim())
        .filter(Boolean);

      const uniq = [...new Set(rawHos)];
      hoList = uniq.sort((a, b) => {
        const na = Number(normalizeHo(a)) || 0;
        const nb = Number(normalizeHo(b)) || 0;
        if (na !== nb) return na - nb;
        return a.localeCompare(b, "ko");
      });

      if (!hoList.length) hoNote = "해당 층에서 호 목록을 찾지 못했습니다.";
    } catch (e) {
      hoNote = `호 목록 조회 실패: ${e.message}`;
    }

    // ------------------------------------------------------------
    // 5) ho가 없으면: 층 item + ho_list까지만 반환
    // ------------------------------------------------------------
    if (!hoInput) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floorItems+hoList",
        input: { address, floor, ho: null },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        floors, // ✅ 계속 유지(프론트가 다시 버튼 만들 때 필요)
        floor_items: floorItems.map(toClientFloorItem),
        pick: pick ? toClientFloorItem(pick) : null,
        ho_list: hoList,
        ho_list_note: hoNote,
      });
    }

    // ------------------------------------------------------------
    // 6) 호별 면적: getBrExposPubuseAreaInfo 우선
    //   - "호별 전유"가 있으면 그 값 반환
    //   - 없으면 "층 전유(hoNm 비어있는 전유)"로 fallback 반환
    // ------------------------------------------------------------
    const wantHoNorm = normalizeHo(hoInput);

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

    // 6-A) 호별 전유(정확 매칭)
    let target = pubItems.find(it =>
      String(it.flrNo || "") === String(floor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm &&
      isExclusive(it)
    );

    let areaM2 = target ? toNumber(target.area) : 0;

    if (areaM2 > 0) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "hoExclusiveExact",
        input: { address, floor, ho: hoInput },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        floors,
        floor_items: floorItems.map(toClientFloorItem),
        pick: pick ? toClientFloorItem(pick) : null,
        ho_list: hoList,
        ho_matched: { hoNm: target.hoNm || "", flrNo: target.flrNo || "" },
        area_m2: areaM2,
        area_pyeong: round2(areaM2 / 3.305785),
        note: "호별 전유면적(공공API 제공)으로 계산했습니다.",
      });
    }

    // 6-B) ✅ fallback: 층 전유(hoNm이 비어있는 전유)
    // 앱에서 “전유 12층 82.32㎡”처럼 나오는 케이스가 바로 이 형태가 많습니다.
    const floorExclusive = pubItems
      .filter(it => String(it.flrNo || "") === String(floor) && isExclusive(it))
      .find(it => !normalizeHo(it.hoNm || "")); // hoNm에 숫자가 아예 없는 경우(공란/“-”)

    const floorAreaM2 = floorExclusive ? toNumber(floorExclusive.area) : 0;

    if (floorAreaM2 > 0) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "hoFallbackToFloorExclusive",
        input: { address, floor, ho: hoInput },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        floors,
        floor_items: floorItems.map(toClientFloorItem),
        pick: pick ? toClientFloorItem(pick) : null,
        ho_list: hoList,
        area_m2: floorAreaM2,
        area_pyeong: round2(floorAreaM2 / 3.305785),
        warning: "해당 호의 전유면적(호별)은 공공 API에서 제공되지 않아, 같은 층의 전유면적(층 단위)으로 대체 표시했습니다.",
      });
    }

    // 6-C) 그래도 없으면 debug
    const samples = pubItems
      .filter(it => String(it.flrNo || "") === String(floor))
      .slice(0, 60)
      .map(it => ({ hoNm: it.hoNm, gb: it.exposPubuseGbCdNm, area: it.area }))
      .filter(Boolean);

    return res.status(404).json({
      ok: false,
      build: BUILD,
      message: "호별/층 전유면적 데이터를 공공API에서 찾지 못했습니다.",
      input: { address, floor, ho: hoInput },
      wantHoNorm,
      samples,
      hint: "이 건물은 전유공용면적 API에 전유 항목이 없을 수 있습니다(데이터 미제공).",
    });

  } catch (e) {
    return res.status(500).json({ ok: false, build: "2025-12-27-FIX-HO-FALLBACK-01", message: e.message });
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

// XML item -> JS obj
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

function normalizeFloor(s) {
  const m = String(s || "").match(/\d+/);
  return m ? m[0] : "";
}

function normalizeHo(s) {
  // "1209호", "1209", "1209-1" => "1209" (앞 숫자만, 0-leading 제거)
  const m = String(s || "").match(/\d+/);
  if (!m) return "";
  const raw = m[0];
  const noLead = raw.replace(/^0+/, "");
  return noLead || "0";
}

function isExclusive(it) {
  return (String(it.exposPubuseGbCd || "") === "1") || (String(it.exposPubuseGbCdNm || "").includes("전유"));
}

function pickBestFloorItem(items) {
  if (!items || !items.length) return null;
  const score = (it) => {
    const area = toNumber(it.area);
    const txt = `${it.mainPurpsCdNm || ""} ${it.etcPurps || ""}`.trim();
    let s = area;
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

function buildFloorsFromFlrItems(flrItemsAll) {
  // 실제 존재하는 flrNo만 추출(숫자층만)
  const nums = flrItemsAll
    .map(it => String(it.flrNo || "").trim())
    .filter(v => /^\d+$/.test(v))
    .map(v => Number(v));

  const max = nums.length ? Math.max(...nums) : 0;

  // “실제 존재하는 층”을 버튼으로 쓰려면 unique set을 반환
  const set = [...new Set(nums)].sort((a, b) => a - b);
  return {
    unique: set,     // 예: [1,2,3,...,13]
    maxFloor: max,   // 예: 13
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
