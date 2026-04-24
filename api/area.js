// api/area.js
// Vercel Serverless Function (Node 18+)
// env: JUSO_KEY, BLD_KEY
//
// 수정 내역
// - 2026-04-23: 페이지네이션 구현 (100건 제한 해결)
// - 2026-04-23: floor_nos 지하/지상 구분 (B1,B2.../1,2...)
// - 2026-04-24: [방법1] mode=all 추가 → 주소 조회 1회로 전체 데이터 반환
//               층/호 클릭 시 추가 API 호출 없음 → 속도 대폭 개선

const BUILD = "2026-04-24-ALL-IN-ONE";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const address  = String(req.query.address || "").trim();
    const floorRaw = req.query.floor != null ? String(req.query.floor).trim() : "";
    const hoInput  = req.query.ho    != null ? String(req.query.ho).trim()    : "";
    const debug    = String(req.query.debug || "").trim() === "1";
    // mode=all → 주소 조회 1회로 전체 데이터 한 번에 반환
    const modeAll  = String(req.query.mode  || "").trim() === "all";

    if (!address) {
      return res.status(400).json({ ok: false, build: BUILD, message: "address 파라미터가 필요합니다." });
    }
    if (!process.env.JUSO_KEY) {
      return res.status(500).json({ ok: false, build: BUILD, message: "JUSO_KEY 환경변수가 없습니다." });
    }
    if (!process.env.BLD_KEY) {
      return res.status(500).json({ ok: false, build: BUILD, message: "BLD_KEY 환경변수가 없습니다." });
    }

    // ── 1) 주소 → 지번키 ──
    const j = await jusoLookup(address);
    const admCd     = String(j.admCd || "");
    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd  = admCd.slice(5, 10);
    const bun       = String(j.lnbrMnnm).padStart(4, "0");
    const ji        = String(j.lnbrSlno).padStart(4, "0");
    const keys      = { sigunguCd, bjdongCd, bun, ji };

    // ── 2) 층별현황 ──
    const flrItems  = await fetchBldItems("getBrFlrOulnInfo", keys);
    const floorList = buildFloorList(flrItems);
    const floorNos  = floorList.map(x => x.gb === "지하" ? `B${x.no}` : x.no);

    // ════════════════════════════════════════════════
    // [mode=all] 주소 조회 1회 → 전체 데이터 반환
    // 프론트에서 층/호 클릭 시 추가 API 호출 없이 처리
    // ════════════════════════════════════════════════
    if (modeAll) {
      // 3개 API 동시 호출
      const [exposItems, pubItems] = await Promise.all([
        fetchBldItems("getBrExposInfo", keys),
        fetchBldItems("getBrExposPubuseAreaInfo", keys),
      ]);

      // 층별 데이터 구성
      const floorData = {};
      for (const f of floorList) {
        const floorNo    = f.no;
        const floorItems = flrItems.filter(it => String(it.flrNo || "") === String(floorNo));
        const pick       = pickBestFloorItem(floorItems);
        const { hoList, hoIndex } = collectHoListForFloor(exposItems, pubItems, floorNo);
        const floorExclusive      = findFloorExclusiveArea(pubItems, floorNo);

        // 호별 전유/공용 breakdown 미리 계산
        const hoBreakdowns = {};
        for (const norm of Object.keys(hoIndex)) {
          const rows = pubItems.filter(it =>
            String(it.flrNo || "") === String(floorNo) &&
            normalizeHo(it.hoNm || "") === norm
          );
          if (!rows.length) continue;

          const sumArea = (pred) =>
            round2(rows.filter(pred).reduce((acc, it) => acc + toNumber(it.area), 0));
          const exclusiveM2 = sumArea(it =>
            String(it.exposPubuseGbCd || "") === "1" || String(it.exposPubuseGbCdNm || "").includes("전유")
          );
          const sharedM2 = sumArea(it =>
            String(it.exposPubuseGbCd || "") === "2" || String(it.exposPubuseGbCdNm || "").includes("공용")
          );
          const totalM2 = round2(exclusiveM2 + sharedM2);

          hoBreakdowns[norm] = {
            sum: {
              exclusive_m2:     exclusiveM2 || null,
              exclusive_pyeong: exclusiveM2 ? round2(exclusiveM2 / 3.305785) : null,
              shared_m2:        sharedM2    || null,
              shared_pyeong:    sharedM2    ? round2(sharedM2    / 3.305785) : null,
              total_m2:         totalM2     || null,
              total_pyeong:     totalM2     ? round2(totalM2     / 3.305785) : null,
            },
            breakdown: rows.map(x => ({
              gb:          x.exposPubuseGbCdNm || codeToGb(x.exposPubuseGbCd),
              flrNm:       x.flrNoNm || (x.flrNo ? `${f.gb}${x.flrNo}층` : ""),
              use:         x.mainPurpsCdNm || x.etcPurps || "",
              area_m2:     toNumber(x.area),
              area_pyeong: round2(toNumber(x.area) / 3.305785),
            })),
          };
        }

        // exposInfo fallback (pubuse에 없는 호 대비)
        const exposFallbacks = {};
        exposItems
          .filter(it => String(it.flrNo || "") === String(floorNo))
          .forEach(it => {
            const norm = normalizeHo(it.hoNm || "");
            if (!norm || hoBreakdowns[norm]) return; // 이미 있으면 skip
            const m2 = toNumber(it.area);
            if (!m2) return;
            exposFallbacks[norm] = {
              sum: {
                exclusive_m2:     m2,
                exclusive_pyeong: round2(m2 / 3.305785),
                shared_m2:        null,
                shared_pyeong:    null,
                total_m2:         m2,
                total_pyeong:     round2(m2 / 3.305785),
              },
              breakdown: [],
              note: "전유부(getBrExposInfo) 면적 기준입니다.",
            };
          });

        const key = f.gb === "지하" ? `B${floorNo}` : floorNo;
        floorData[key] = {
          floor_items:            floorItems.map(toClientFloorItem),
          pick:                   pick ? toClientFloorItem(pick) : null,
          ho_list:                hoList,
          ho_index:               hoIndex,
          ho_breakdowns:          { ...hoBreakdowns, ...exposFallbacks },
          floor_exclusive_m2:     floorExclusive?.m2 ?? null,
          floor_exclusive_pyeong: floorExclusive?.m2 ? round2(floorExclusive.m2 / 3.305785) : null,
        };
      }

      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "all",
        road:      j.roadAddr  || "",
        jibun:     j.jibunAddr || "",
        keys,
        floor_nos: floorNos,
        floor_data: floorData,   // 층 키 → 데이터
      });
    }

    // ════════════════════════════════════════════════
    // 이하 기존 개별 모드 (하위 호환 유지)
    // ════════════════════════════════════════════════
    const floorNorm      = normalizeFloor(floorRaw);
    const effectiveFloor = floorNorm ||
      (floorList.find(f => f.gb === "지상")?.no ?? floorList[0]?.no ?? "");

    if (!floorRaw && !hoInput) {
      return res.status(200).json({
        ok: true, build: BUILD, mode: "summary",
        input: { address, floor: null, ho: null },
        road: j.roadAddr || "", jibun: j.jibunAddr || "",
        keys, floors: floorList, floor_nos: floorNos,
      });
    }

    if (!effectiveFloor) {
      return res.status(404).json({
        ok: false, build: BUILD,
        message: "층 정보를 찾지 못했습니다.",
        input: { address, floor: floorRaw, ho: hoInput }, keys,
      });
    }

    const floorItems = flrItems.filter(it => String(it.flrNo || "") === String(effectiveFloor));
    const pick       = pickBestFloorItem(floorItems);

    if (debug) {
      const dbg = await debugHoSources(keys, effectiveFloor);
      return res.status(200).json({
        ok: true, build: BUILD, mode: "debug",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road: j.roadAddr || "", jibun: j.jibunAddr || "",
        keys, floor: String(effectiveFloor), debug: dbg,
      });
    }

    if (!hoInput) {
      const [exposItems, pubItems] = await Promise.all([
        fetchBldItems("getBrExposInfo", keys),
        fetchBldItems("getBrExposPubuseAreaInfo", keys),
      ]);
      const { hoList, hoNote, hoIndex } = collectHoListForFloor(exposItems, pubItems, effectiveFloor);
      const floorExclusive = findFloorExclusiveArea(pubItems, effectiveFloor);
      return res.status(200).json({
        ok: true, build: BUILD, mode: "floor",
        input: { address, floor: effectiveFloor, ho: null },
        road: j.roadAddr || "", jibun: j.jibunAddr || "",
        keys, floor_nos: floorNos,
        floor_items: floorItems.map(toClientFloorItem),
        pick: pick ? toClientFloorItem(pick) : null,
        ho_list: hoList, ho_list_note: hoNote, ho_index: hoIndex,
        floor_exclusive_m2:     floorExclusive?.m2 ?? null,
        floor_exclusive_pyeong: floorExclusive?.m2 ? round2(floorExclusive.m2 / 3.305785) : null,
        floor_exclusive_note:   floorExclusive?.note ?? null,
      });
    }

    const wantHoNorm = normalizeHo(hoInput);
    const pubItems   = await fetchBldItems("getBrExposPubuseAreaInfo", keys);

    let hoRows = pubItems.filter(it =>
      String(it.flrNo || "") === String(effectiveFloor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm
    );
    if (!hoRows.length) {
      hoRows = pubItems.filter(it => {
        if (String(it.flrNo || "") !== String(effectiveFloor)) return false;
        const raw = String(it.hoNm || "").trim();
        if (!raw) return false;
        return new RegExp(`(^|[^0-9])${escapeReg(wantHoNorm)}([^0-9]|$)`).test(raw);
      });
    }

    if (hoRows.length) {
      const breakdown = hoRows.map(x => ({
        gb: x.exposPubuseGbCdNm || codeToGb(x.exposPubuseGbCd),
        flrNm: x.flrNoNm || (x.flrNo ? `지상${x.flrNo}층` : ""),
        use: x.mainPurpsCdNm || x.etcPurps || "",
        area_m2: toNumber(x.area),
        area_pyeong: round2(toNumber(x.area) / 3.305785),
      }));
      const sumArea = (pred) =>
        round2(hoRows.filter(pred).reduce((acc, it) => acc + toNumber(it.area), 0));
      const exclusiveM2 = sumArea(it =>
        String(it.exposPubuseGbCd || "") === "1" || String(it.exposPubuseGbCdNm || "").includes("전유"));
      const sharedM2 = sumArea(it =>
        String(it.exposPubuseGbCd || "") === "2" || String(it.exposPubuseGbCdNm || "").includes("공용"));
      const totalM2 = round2(exclusiveM2 + sharedM2);
      return res.status(200).json({
        ok: true, build: BUILD, mode: "ho_breakdown",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road: j.roadAddr || "", jibun: j.jibunAddr || "",
        keys, ho_matched: { want: hoInput, wantHoNorm },
        breakdown,
        sum: {
          exclusive_m2: exclusiveM2 || null,
          exclusive_pyeong: exclusiveM2 ? round2(exclusiveM2 / 3.305785) : null,
          shared_m2: sharedM2 || null,
          shared_pyeong: sharedM2 ? round2(sharedM2 / 3.305785) : null,
          total_m2: totalM2 || null,
          total_pyeong: totalM2 ? round2(totalM2 / 3.305785) : null,
        },
        note: "getBrExposPubuseAreaInfo 기준",
      });
    }

    const exposItems2 = await fetchBldItems("getBrExposInfo", keys);
    const target = exposItems2.find(it =>
      String(it.flrNo || "") === String(effectiveFloor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm
    );
    const areaM2 = target ? toNumber(target.area) : 0;
    if (areaM2 > 0) {
      return res.status(200).json({
        ok: true, build: BUILD, mode: "exposInfo_fallback",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road: j.roadAddr || "", jibun: j.jibunAddr || "", keys,
        ho_matched: { hoNm: target.hoNm, flrNo: target.flrNo },
        sum: {
          exclusive_m2: areaM2, exclusive_pyeong: round2(areaM2 / 3.305785),
          shared_m2: null, shared_pyeong: null,
          total_m2: areaM2, total_pyeong: round2(areaM2 / 3.305785),
        },
        note: "전유부(getBrExposInfo) 면적 기준입니다.",
      });
    }

    const floorExclusive2 = findFloorExclusiveArea(pubItems, effectiveFloor);
    if (floorExclusive2?.m2) {
      return res.status(200).json({
        ok: true, build: BUILD, mode: "floorExclusive_fallback",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road: j.roadAddr || "", jibun: j.jibunAddr || "", keys,
        sum: {
          exclusive_m2: floorExclusive2.m2,
          exclusive_pyeong: round2(floorExclusive2.m2 / 3.305785),
          shared_m2: null, shared_pyeong: null,
          total_m2: floorExclusive2.m2,
          total_pyeong: round2(floorExclusive2.m2 / 3.305785),
        },
        note: "해당 호 데이터가 누락되어 층 전유 면적으로 안내합니다.",
      });
    }

    return res.status(404).json({
      ok: false, build: BUILD,
      message: "해당 층/호 면적 데이터를 찾지 못했습니다.",
      input: { address, floor: effectiveFloor, ho: hoInput }, wantHoNorm,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, build: BUILD, message: e.message });
  }
};

/* =====================================================
   helpers
   ===================================================== */

async function jusoLookup(keyword) {
  const url = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
  url.searchParams.set("confmKey",     process.env.JUSO_KEY);
  url.searchParams.set("currentPage",  "1");
  url.searchParams.set("countPerPage", "10");
  url.searchParams.set("keyword",      keyword);
  url.searchParams.set("resultType",   "json");
  const data = await (await fetch(url.toString())).json();
  const j = data?.results?.juso?.[0];
  if (!j) throw new Error("주소를 찾지 못했습니다. (JUSO 결과 없음)");
  return j;
}

async function fetchBldItems(apiName, keys) {
  const PAGE_SIZE = 100;
  let pageNo   = 1;
  let allItems = [];
  while (true) {
    const url = new URL(`https://apis.data.go.kr/1613000/BldRgstHubService/${apiName}`);
    url.searchParams.set("serviceKey", process.env.BLD_KEY);
    url.searchParams.set("sigunguCd",  keys.sigunguCd);
    url.searchParams.set("bjdongCd",   keys.bjdongCd);
    url.searchParams.set("bun",        keys.bun);
    url.searchParams.set("ji",         keys.ji);
    url.searchParams.set("numOfRows",  String(PAGE_SIZE));
    url.searchParams.set("pageNo",     String(pageNo));
    const xml = await (await fetch(url.toString())).text();
    assertApiOk(xml, apiName);
    const totalCount = parseInt(
      String(xml).match(/<totalCount>(\d+)<\/totalCount>/)?.[1] || "0", 10
    );
    const items = parseItems(xml).map(itemXmlToObj);
    allItems = allItems.concat(items);
    if (allItems.length >= totalCount || items.length < PAGE_SIZE) break;
    pageNo++;
    if (pageNo > 30) break;
  }
  return allItems;
}

function parseItems(xmlText) {
  return [...String(xmlText || "").matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}

function getTag(xmlChunk, tag) {
  const m = String(xmlChunk || "").match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}

function itemXmlToObj(item) {
  const tags = [
    "flrNo", "flrNoNm", "flrGbCdNm",
    "hoNm", "dongNm",
    "exposPubuseGbCd", "exposPubuseGbCdNm",
    "mainPurpsCdNm", "etcPurps",
    "strctCdNm", "strctCd",
    "area",
  ];
  const o = {};
  for (const t of tags) o[t] = getTag(item, t);
  return o;
}

function assertApiOk(xmlText, apiName) {
  const resultCode = String(xmlText || "").match(/<resultCode>(.*?)<\/resultCode>/)?.[1]?.trim() || "";
  const resultMsg  = String(xmlText || "").match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1]?.trim()  || "";
  if (resultCode && resultCode !== "00") {
    throw new Error(`${apiName} 호출 실패: ${resultCode} ${resultMsg}`);
  }
  if (String(xmlText || "").includes("API not found")) {
    throw new Error(`${apiName} 호출 실패: API not found`);
  }
}

function toNumber(v) {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Number(Number(n).toFixed(2));
}

function normalizeHo(s) {
  const m = String(s || "").match(/\d+/);
  return m ? m[0] : "";
}

function normalizeFloor(s) {
  const upper = String(s || "").toUpperCase().trim();
  if (upper.startsWith("B")) {
    const n = parseInt(upper.slice(1), 10);
    return Number.isFinite(n) ? String(-n) : "";
  }
  const m = upper.match(/-?\d+/);
  return m ? String(Number(m[0])) : "";
}

function buildFloorList(flrItems) {
  const map = new Map();
  for (const it of flrItems || []) {
    const no = String(it.flrNo || "").trim();
    if (!no) continue;
    const gb  = (it.flrGbCdNm || "").includes("지하") ? "지하" : "지상";
    const key = `${gb}:${no}`;
    if (!map.has(key)) map.set(key, { gb, no });
  }
  const arr = [...map.values()];
  arr.sort((a, b) => {
    if (a.gb !== b.gb) return a.gb === "지하" ? -1 : 1;
    return Number(a.no) - Number(b.no);
  });
  return arr;
}

function pickBestFloorItem(items) {
  if (!items || !items.length) return null;
  const score = (it) => {
    const area = toNumber(it.area);
    const txt  = `${it.mainPurpsCdNm || ""} ${it.etcPurps || ""}`.trim();
    let s = area;
    if (txt.includes("공용")) s -= 100000;
    if (txt.includes("업무") || txt.includes("사무")) s += 50000;
    return s;
  };
  return items.slice().sort((a, b) => score(b) - score(a))[0];
}

function toClientFloorItem(it) {
  const areaM2 = toNumber(it.area);
  return {
    gb:          it.flrGbCdNm     || "-",
    use:         it.mainPurpsCdNm || "-",
    detail:      it.etcPurps      || "-",
    flrNo:       it.flrNo         || "",
    flrNoNm:     it.flrNoNm       || "",
    area_m2:     areaM2,
    area_pyeong: round2(areaM2 / 3.305785),
  };
}

function codeToGb(code) {
  const c = String(code || "");
  if (c === "1") return "전유";
  if (c === "2") return "공용";
  return c || "";
}

function escapeReg(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectHoListForFloor(exposItems, pubItems, floor) {
  const hoSet   = new Set();
  const hoIndex = {};
  let   hoNote  = "";

  const addHo = (hoNm, src) => {
    const raw = String(hoNm || "").trim();
    if (!raw) return;
    hoSet.add(raw);
    const norm = normalizeHo(raw);
    if (!norm) return;
    if (!hoIndex[norm]) {
      hoIndex[norm] = {
        norm, samples: [], hasExclusive: false,
        exclusive_m2: 0, shared_m2: 0, sources: new Set(),
      };
    }
    const idx = hoIndex[norm];
    idx.sources.add(src);
    if (idx.samples.length < 5 && !idx.samples.includes(raw)) idx.samples.push(raw);
  };

  try {
    exposItems
      .filter(it => String(it.flrNo || "") === String(floor))
      .forEach(it => addHo(it.hoNm, "exposInfo"));
  } catch (e) { hoNote += `exposInfo 실패: ${e.message} `; }

  try {
    pubItems
      .filter(it => String(it.flrNo || "") === String(floor))
      .forEach(it => {
        addHo(it.hoNm, "pubuseArea");
        const norm = normalizeHo(it.hoNm || "");
        if (!norm || !hoIndex[norm]) return;
        const isExclusive =
          String(it.exposPubuseGbCd || "") === "1" ||
          String(it.exposPubuseGbCdNm || "").includes("전유");
        const isShared =
          String(it.exposPubuseGbCd || "") === "2" ||
          String(it.exposPubuseGbCdNm || "").includes("공용");
        const a = toNumber(it.area);
        if (isExclusive) { hoIndex[norm].hasExclusive = true; hoIndex[norm].exclusive_m2 += a; }
        else if (isShared) { hoIndex[norm].shared_m2 += a; }
      });

    Object.values(hoIndex).forEach(v => {
      v.exclusive_m2     = round2(v.exclusive_m2);
      v.shared_m2        = round2(v.shared_m2);
      v.total_m2         = round2(v.exclusive_m2 + v.shared_m2);
      v.exclusive_pyeong = v.exclusive_m2 ? round2(v.exclusive_m2 / 3.305785) : null;
      v.shared_pyeong    = v.shared_m2    ? round2(v.shared_m2    / 3.305785) : null;
      v.total_pyeong     = v.total_m2     ? round2(v.total_m2     / 3.305785) : null;
      v.sources          = [...v.sources];
    });
  } catch (e) { hoNote += `pubuseArea 실패: ${e.message} `; }

  const hoList = [...hoSet].sort((a, b) => {
    const na = Number(normalizeHo(a)) || 0;
    const nb = Number(normalizeHo(b)) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "ko");
  });

  if (!hoList.length) hoNote = (hoNote || "") + "해당 층에서 호 목록을 찾지 못했습니다.";
  return { hoList, hoNote: hoNote.trim(), hoIndex };
}

function findFloorExclusiveArea(pubItems, floor) {
  try {
    const candidates = pubItems.filter(it => {
      if (String(it.flrNo || "") !== String(floor)) return false;
      const isExclusive =
        String(it.exposPubuseGbCd || "") === "1" ||
        String(it.exposPubuseGbCdNm || "").includes("전유");
      if (!isExclusive) return false;
      const hoNorm = normalizeHo(it.hoNm || "");
      const hoRaw  = String(it.hoNm || "").trim();
      return !hoRaw || !hoNorm;
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => (toNumber(b.area) || 0) - (toNumber(a.area) || 0));
    const best = candidates[0];
    const m2   = toNumber(best.area);
    if (!m2) return null;
    return {
      m2,
      note: `flrNo=${best.flrNo}, gb=${best.exposPubuseGbCdNm || best.exposPubuseGbCd}, hoNm="${best.hoNm || ""}"`,
    };
  } catch { return null; }
}

async function debugHoSources(keys, floor) {
  const out  = {};
  const apis = ["getBrExposInfo", "getBrExposPubuseAreaInfo", "getBrTitleInfo"];
  for (const apiName of apis) {
    try {
      const items      = await fetchBldItems(apiName, keys);
      const floorItems = items.filter(it => String(it.flrNo || "") === String(floor));
      out[apiName] = {
        total: items.length,
        floorCount: floorItems.length,
        hoNmSamples: floorItems.map(it => it.hoNm).filter(Boolean).slice(0, 80),
      };
    } catch (e) { out[apiName] = { error: e.message }; }
  }
  return out;
}
