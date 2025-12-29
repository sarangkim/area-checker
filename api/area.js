// api/area.js
// Vercel Serverless Function (Node 18+)

const BUILD = "2025-12-28-FIX-01";

/* ----------------- main handler ----------------- */
module.exports = async (req, res) => {
  try {
    const address = String(req.query.address || "").trim();
    const floor = req.query.floor != null ? String(req.query.floor).trim() : "";
    const hoInput = req.query.ho != null ? String(req.query.ho).trim() : "";

    if (!address) {
      return res.status(400).json({ ok: false, build: BUILD, message: "address 파라미터가 필요합니다." });
    }
    if (!process.env.JUSO_KEY) {
      return res.status(500).json({ ok: false, build: BUILD, message: "JUSO_KEY 환경변수가 없습니다." });
    }
    if (!process.env.BLD_KEY) {
      return res.status(500).json({ ok: false, build: BUILD, message: "BLD_KEY(건축HUB serviceKey) 환경변수가 없습니다." });
    }

    // 1) 주소 → PNU/행정코드(지번) 만들기 (JUSO)
    const j = await jusoLookup(address);

    const admCd = j.admCd; // 10자리
    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd = admCd.slice(5, 10);
    const bun = String(j.lnbrMnnm).padStart(4, "0");
    const ji = String(j.lnbrSlno).padStart(4, "0");

    const baseKeys = { sigunguCd, bjdongCd, bun, ji };

    // 2) 층별현황: getBrFlrOulnInfo (층 item 여러 개 가능)
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

    // ✅ 실제 존재하는 층 목록(지상/지하 구분 포함)
    const floorList = buildFloorList(flrItems);

    // floor 파라미터가 없으면: 기본으로 첫 지상층을 선택
    const effectiveFloor = floor || (floorList.find(f => f.gb === "지상")?.no ?? floorList[0]?.no ?? "1");

    // 해당 층만 필터
    const floorItems = flrItems.filter(it => String(it.flrNo || "") === String(effectiveFloor));
    const pick = pickBestFloorItem(floorItems);

    // 3) 호별 요청이 없으면: 층 item + ho_list
    if (!hoInput) {
      const { hoList, hoNote } = await buildHoListForFloor({ sigunguCd, bjdongCd, bun, ji, floor: effectiveFloor });

      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floorItems+hoList",
        input: { address, floor: effectiveFloor, ho: null },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        floor_list: floorList,                 // ✅ 프론트가 실제 층만 그리게
        floor_items: floorItems.map(toClientFloorItem),
        pick: pick ? toClientFloorItem(pick) : null,
        ho_list: hoList,
        ho_list_note: hoNote,
      });
    }

    // ------------------------------------------------------------
    // 4) 호별 면적: (A) getBrExposInfo (전유부) 우선
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

    let target = exposItems.find(it =>
      String(it.flrNo || "") === String(effectiveFloor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm
    );

    let areaM2 = target ? toNumber(target.area) : 0;

    if (areaM2 > 0) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "exposInfo(전유부) ho-match",
        input: { address, floor: effectiveFloor, ho: hoInput },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        ho_matched: { hoNm: target.hoNm, flrNo: target.flrNo, dongNm: target.dongNm || "" },
        area_m2: areaM2,
        area_pyeong: round2(areaM2 / 3.305785),
        note: "전유부(getBrExposInfo)의 area 사용",
      });
    }

    // ------------------------------------------------------------
    // 5) (B) getBrExposPubuseAreaInfo에서 찾기 (전유 우선, 없으면 max(area) fallback)
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

    const matches = pubItems.filter(it =>
      String(it.flrNo || "") === String(effectiveFloor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm
    );

    // 5-1) 전유(1) 우선
    let best = matches.find(it => String(it.exposPubuseGbCd || "") === "1" || String(it.exposPubuseGbCdNm || "").includes("전유"));
    // 5-2) 없으면 area 가장 큰 값으로 fallback
    if (!best && matches.length) {
      best = matches
        .slice()
        .sort((a, b) => (toNumber(b.area) || 0) - (toNumber(a.area) || 0))[0];
    }

    areaM2 = best ? toNumber(best.area) : 0;

    if (areaM2 > 0) {
      const gb = best.exposPubuseGbCdNm || best.exposPubuseGbCd || "";
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "exposPubuseArea ho-match",
        input: { address, floor: effectiveFloor, ho: hoInput },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        ho_matched: { hoNm: best.hoNm, flrNo: best.flrNo, dongNm: best.dongNm || "" },
        area_m2: areaM2,
        area_pyeong: round2(areaM2 / 3.305785),
        note: `getBrExposPubuseAreaInfo 사용 (구분=${gb || "미상"})`,
        debug: {
          matched_count: matches.length,
          used_rule: (String(best.exposPubuseGbCd || "") === "1" || String(best.exposPubuseGbCdNm || "").includes("전유"))
            ? "전유 우선"
            : "전유 없음 → max(area) fallback",
        }
      });
    }

    // 그래도 못 찾으면: 디버그용 샘플
    return res.status(404).json({
      ok: false,
      build: BUILD,
      message: "해당 층/호 면적 데이터를 공공API에서 찾지 못했습니다.",
      input: { address, floor: effectiveFloor, ho: hoInput },
      wantHoNorm,
      hint: "이 건물은 전유면적 API에 전유 항목이 없거나, 호 표기(예: 1209호/1209-1)가 다를 수 있습니다.",
      pubuse_samples: matches.slice(0, 50).map(x => ({ hoNm: x.hoNm, flrNo: x.flrNo, gb: x.exposPubuseGbCdNm, area: x.area })),
    });

  } catch (e) {
    return res.status(500).json({ ok: false, build: BUILD, message: e.message });
  }
};

/* ----------------- helpers ----------------- */

async function jusoLookup(keyword) {
  const url = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
  url.searchParams.set("confmKey", process.env.JUSO_KEY);
  url.searchParams.set("currentPage", "1");
  url.searchParams.set("countPerPage", "10");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("resultType", "json");

  const data = await (await fetch(url.toString())).json();
  const j = data?.results?.juso?.[0];
  if (!j) throw new Error("주소를 찾지 못했습니다. (JUSO 결과 없음)");
  // admCd, lnbrMnnm, lnbrSlno, jibunAddr, roadAddr
  return j;
}

function getTag(xmlChunk, tag) {
  const m = xmlChunk.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}

function parseItems(xmlText) {
  return [...xmlText.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}

function itemXmlToObj(xmlChunk) {
  // 필요한 태그만 느슨하게
  const tags = [
    "flrGbCdNm", "flrNo", "flrNoNm",
    "mainPurpsCdNm", "etcPurps",
    "exposPubuseGbCd", "exposPubuseGbCdNm",
    "dongNm", "hoNm",
    "area"
  ];
  const obj = {};
  for (const t of tags) obj[t] = getTag(xmlChunk, t);
  return obj;
}

function assertApiOk(xml, apiName) {
  const resultCode = getTag(xml, "resultCode");
  const resultMsg = getTag(xml, "resultMsg");
  if (resultCode && resultCode !== "00") {
    throw new Error(`${apiName} 실패: ${resultCode} / ${resultMsg || ""}`.trim());
  }
}

function toNumber(v) {
  const n = Number(String(v || "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function normalizeHo(s) {
  // "1209호", "1209-1", " 1209 " => "1209"
  const m = String(s || "").match(/\d+/);
  return m ? m[0] : "";
}

function toClientFloorItem(it) {
  return {
    gb: it.flrGbCdNm || "",
    use: it.mainPurpsCdNm || "",
    detail: it.etcPurps || "",
    flrNo: it.flrNo || "",
    area_m2: toNumber(it.area),
    area_pyeong: round2(toNumber(it.area) / 3.305785),
  };
}

function pickBestFloorItem(items) {
  if (!items || !items.length) return null;
  // 업무/주용도 느낌 우선
  const preferred = items.slice().sort((a, b) => {
    const aScore = scoreUse(a);
    const bScore = scoreUse(b);
    if (aScore !== bScore) return bScore - aScore;
    return (toNumber(b.area) || 0) - (toNumber(a.area) || 0);
  });
  return preferred[0];
}

function scoreUse(it) {
  const s = `${it.mainPurpsCdNm || ""} ${it.etcPurps || ""}`;
  // 공용시설/계단/승강기 같은 것 낮게
  if (s.includes("공용")) return 1;
  if (s.includes("계단") || s.includes("승강기") || s.includes("복도")) return 1;
  // 업무시설/사무소/근린 등 높게
  if (s.includes("사무") || s.includes("업무") || s.includes("근린")) return 3;
  return 2;
}

function buildFloorList(flrItems) {
  const seen = new Set();
  const list = [];

  for (const it of flrItems || []) {
    const gb = (it.flrGbCdNm || "").trim(); // 지상/지하
    const no = String(it.flrNo || "").trim();
    if (!no) continue;
    const key = `${gb}:${no}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ gb: gb || "", no });
  }

  // 정렬: 지하 먼저(큰 지하부터?), 지상은 1,2,3...
  list.sort((a, b) => {
    const ag = a.gb.includes("지하") ? 0 : 1;
    const bg = b.gb.includes("지하") ? 0 : 1;
    if (ag !== bg) return ag - bg;
    const an = Number(a.no) || 0;
    const bn = Number(b.no) || 0;
    return ag === 0 ? (bn - an) : (an - bn);
  });

  return list;
}

async function buildHoListForFloor({ sigunguCd, bjdongCd, bun, ji, floor }) {
  let hoNote = "";
  const hoSet = new Set();

  // (A) getBrExposInfo에서 호 수집
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

    exposItems
      .filter(it => String(it.flrNo || "") === String(floor))
      .map(it => (it.hoNm || "").trim())
      .filter(Boolean)
      .forEach(h => hoSet.add(h));
  } catch (e) {
    hoNote += `exposInfo 호수집 실패: ${e.message} `;
  }

  // (B) getBrExposPubuseAreaInfo에서도 호 수집(✅ 누락 보완)
  try {
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

    pubItems
      .filter(it => String(it.flrNo || "") === String(floor))
      .map(it => (it.hoNm || "").trim())
      .filter(Boolean)
      .forEach(h => hoSet.add(h));
  } catch (e) {
    hoNote += `pubuseArea 호수집 실패: ${e.message}`;
  }

  // 정렬(숫자 기준)
  const hoList = [...hoSet].sort((a, b) => {
    const na = Number(normalizeHo(a)) || 0;
    const nb = Number(normalizeHo(b)) || 0;
    if (na !== nb) return na - nb;
    return a.localeCompare(b, "ko");
  });

  if (!hoList.length) hoNote = (hoNote || "") + "해당 층에서 호 목록을 찾지 못했습니다.";

  return { hoList, hoNote: hoNote.trim() };
}
