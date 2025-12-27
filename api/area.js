// /pages/api/area.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD = "2025-12-27-AREA-02";

  const address = (req.query.address || "").trim();
  const floor = String(req.query.floor || "").trim(); // (현재 구조) floor는 필수
  const hoInput = (req.query.ho || "").trim();        // 선택

  if (!address || !floor) {
    return res.status(400).json({ ok: false, build: BUILD, message: "address와 floor는 필수입니다." });
  }

  try {
    // 1) JUSO 주소 → 지번(행정코드)
    const jusoUrl = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
    jusoUrl.searchParams.set("confmKey", process.env.JUSO_KEY);
    jusoUrl.searchParams.set("currentPage", "1");
    jusoUrl.searchParams.set("countPerPage", "10");
    jusoUrl.searchParams.set("keyword", address);
    jusoUrl.searchParams.set("resultType", "json");

    const jusoData = await (await fetch(jusoUrl.toString())).json();
    const jusoList = jusoData?.results?.juso || [];
    if (!jusoList.length) throw new Error("주소 검색 결과가 없습니다.");

    const j = jusoList[0];
    const admCd = j.admCd;

    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd = admCd.slice(5, 10);
    const bun = String(j.lnbrMnnm).padStart(4, "0");
    const ji = String(j.lnbrSlno).padStart(4, "0");

    const baseKeys = { sigunguCd, bjdongCd, bun, ji };

    // 2) 층별현황: getBrFlrOulnInfo → 같은 층 item 여러개 가능
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
    const floorItems = flrItems.filter(it => String(it.flrNo || "") === String(floor));
    const pick = pickBestFloorItem(floorItems);

    // 3) ho가 없으면: 층 item 목록 + pick + 해당 층 ho_list(드롭다운용)
    if (!hoInput) {
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

        hoList = Array.from(new Set(rawHos)).sort((a, b) => {
          const na = Number(normalizeHo(a)) || 0;
          const nb = Number(normalizeHo(b)) || 0;
          if (na !== nb) return na - nb;
          return a.localeCompare(b, "ko");
        });

        if (!hoList.length) hoNote = "해당 층에서 호 목록을 찾지 못했습니다.";
      } catch (e) {
        hoNote = `호 목록 조회 실패: ${e.message}`;
      }

      // 대표 면적: pick이 있으면 pick.area, 없으면 0
      const areaM2 = pick ? toNumber(pick.area) : 0;

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
        area_m2: areaM2,
        area_pyeong: round2(areaM2 / 3.305785),
        ho_list: hoList,
        note: hoNote || "층별현황 item 여러 개는 floor_items에 모두 표시합니다. 대표 면적은 pick입니다."
      });
    }

    // 4) 호별 면적: (A) getBrExposInfo(전유부)에서 먼저 찾기
    const wantHoNorm = normalizeHo(hoInput);

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

    let target = exposItems.find(it =>
      String(it.flrNo || "") === String(floor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm
    );

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

    // 5) (B) getBrExposPubuseAreaInfo에서 전유(1)로 찾기
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

    // 6) 못 찾으면 샘플 내려줌
    const hoSamples = pubItems
      .filter(it => String(it.flrNo || "") === String(floor))
      .slice(0, 50)
      .map(it => it.hoNm)
      .filter(Boolean);

    return res.status(404).json({
      ok: false,
      build: BUILD,
      message: "전유부/전유공용면적 조회에서 해당 층/호 전유면적을 찾지 못했습니다. (hoNm 표기 확인 필요)",
      input: { address, floor, ho: hoInput },
      wantHoNorm,
      hoNmSamples: hoSamples,
      note: "예: '802', '802호', '802-1' → 현재는 '802'로 정규화해 매칭합니다.",
    });

  } catch (e) {
    return res.status(500).json({ ok: false, build: BUILD, message: e.message });
  }
}

/* ----------------- helpers ----------------- */
function normalizeHo(s) {
  // "802호" -> "802"
  // "802-1" -> "802" (부번 무시)
  const t = String(s || "").trim();
  const beforeDash = t.split("-")[0];             // "802-1"이면 "802"
  const digits = beforeDash.replace(/[^\d]/g, ""); // 숫자만
  return digits;
}

function pickBestFloorItem(items) {
  if (!items || !items.length) return null;

  // “업무/사무/근린생활” 같은 주용도를 우선,
  // “공용/복도/계단/화장실/기계/전기” 등은 점수 낮게
  const badWords = ["공용", "복도", "계단", "화장실", "기계", "전기", "공조", "주차", "설비"];
  const goodWords = ["업무", "사무", "근린", "판매", "교육", "의료", "숙박"];

  const scored = items.map(it => {
    const purp = (it.mainPurpsCdNm || "") + " " + (it.etcPurps || "") + " " + (it.etcStrct || "");
    const area = toNumber(it.area);
    let score = 0;

    for (const w of goodWords) if (purp.includes(w)) score += 50;
    for (const w of badWords) if (purp.includes(w)) score -= 60;

    // 면적은 가산(너무 크게 좌우하지 않게 log 느낌으로)
    score += Math.min(30, Math.log10(Math.max(area, 1)) * 10);

    return { it, score, area };
  });

  scored.sort((a, b) => (b.score - a.score) || (b.area - a.area));
  return scored[0].it;
}

function toClientFloorItem(it) {
  return {
    flrNo: it.flrNo,
    flrGbCdNm: it.flrGbCdNm,
    mainPurpsCdNm: it.mainPurpsCdNm,
    etcPurps: it.etcPurps,
    area: toNumber(it.area),
    area_pyeong: round2(toNumber(it.area) / 3.305785),
  };
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function toNumber(v) {
  const n = Number(String(v || "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function assertApiOk(xmlText, op) {
  const code = getTag(xmlText, "resultCode");
  const msg = getTag(xmlText, "resultMsg");
  if (code && code !== "00") throw new Error(`${op} 실패: ${code} ${msg}`);
}
function getTag(xmlChunk, tag) {
  const m = xmlChunk.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}
function parseItems(xmlText) {
  return [...xmlText.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}
function itemXmlToObj(itemXml) {
  const obj = {};
  const tags = [...itemXml.matchAll(/<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g)];
  for (const t of tags) obj[t[1]] = (t[2] || "").trim();
  return obj;
}
