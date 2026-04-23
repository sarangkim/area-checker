// api/area.js
// Vercel Serverless Function (Node 18+)
// env: JUSO_KEY, BLD_KEY
//
// 수정 내역
// - 2026-04-23: 페이지네이션 구현 (100건 제한 해결 → 전체 데이터 조회)
// - 2026-04-23: floor_nos 지하/지상 구분 (B1, B2... / 1, 2...) → 버튼 중복 제거
// - 2026-04-23: collectHoListForFloor 내 중복 fetchBldItems 호출 제거 (캐시 활용)
// - 2026-04-23: mode=all 추가 → 전체 층/호 데이터를 한 번에 반환 (프리로드 캐시용)

const BUILD = "2026-04-23-ALL-MODE";

module.exports = async (req, res) => {
  // ---- CORS ----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const address  = String(req.query.address || "").trim();
    const floorRaw = req.query.floor != null ? String(req.query.floor).trim() : "";
    const hoInput  = req.query.ho    != null ? String(req.query.ho).trim()    : "";
    const modeAll  = String(req.query.mode || "").trim() === "all";
    const debug    = String(req.query.debug || "").trim() === "1";

    if (!address) {
      return res.status(400).json({ ok: false, build: BUILD, message: "address 파라미터가 필요합니다." });
    }
    if (!process.env.JUSO_KEY) {
      return res.status(500).json({ ok: false, build: BUILD, message: "JUSO_KEY 환경변수가 없습니다." });
    }
    if (!process.env.BLD_KEY) {
      return res.status(500).json({ ok: false, build: BUILD, message: "BLD_KEY(건축HUB serviceKey) 환경변수가 없습니다." });
    }

    // 1) 주소 → 행정코드/지번키 (JUSO)
    const j = await jusoLookup(address);

    const admCd     = String(j.admCd || "");
    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd  = admCd.slice(5, 10);
    const bun       = String(j.lnbrMnnm).padStart(4, "0");
    const ji        = String(j.lnbrSlno).padStart(4, "0");
    const keys      = { sigunguCd, bjdongCd, bun, ji };

    // 2) 층별현황 (getBrFlrOulnInfo) — 전체 페이지 조회
    const flrItems  = await fetchBldItems("getBrFlrOulnInfo", keys);
    const floorList = buildFloorList(flrItems);
    const floorNos  = floorList.map(x => x.gb === "지하" ? `B${x.no}` : x.no);

    // =====================================================
    // mode=all: 전체 층/호 데이터를 한 번에 반환 (프리로드용)
    // =====================================================
    if (modeAll) {
      // exposInfo + pubuseAreaInfo 를 한 번씩만 호출
      const [exposItems, pubItems] = await Promise.all([
        fetchBldItems("getBrExposInfo", keys),
        fetchBldItems("getBrExposPubuseAreaInfo", keys),
      ]);

      // 층별 데이터 구성
      const floorsData = {};
      for (const f of floorList) {
        const fNo = String(f.no);
        const floorKey = f.gb === "지하" ? `B${fNo}` : fNo;

        const floorItems     = flrItems.filter(it => String(it.flrNo || "") === fNo);
        const pick           = pickBestFloorItem(floorItems);
        const floorExclusive = findFloorExclusiveArea(pubItems, fNo);
        const { hoList, hoNote, hoIndex } = collectHoListForFloor(exposItems, pubItems, fNo);

        // 호별 breakdown 구성
        const hoBreakdown = {};
        for (const hoNm of hoList) {
          const wantHoNorm = normalizeHo(hoNm);

          let hoRows = pubItems.filter(it =>
            String(it.flrNo || "") === fNo &&
            normalizeHo(it.hoNm || "") === wantHoNorm
          );
          if (!hoRows.length) {
            hoRows = pubItems.filter(it => {
              if (String(it.flrNo || "") !== fNo) return false;
              const raw = String(it.hoNm || "").trim();
              if (!raw) return false;
              return new RegExp(`(^|[^0-9])${escapeReg(wantHoNorm)}([^0-9]|$)`).test(raw);
            });
          }

          if (hoRows.length) {
            const sumArea = (pred) =>
              round2(hoRows.filter(pred).reduce((acc, it) => acc + toNumber(it.area), 0));
            const exclusiveM2 = sumArea(it =>
              String(it.exposPubuseGbCd || "") === "1" || String(it.exposPubuseGbCdNm || "").includes("전유")
            );
            const sharedM2 = sumArea(it =>
              String(it.exposPubuseGbCd || "") === "2" || String(it.exposPubuseGbCdNm || "").includes("공용")
            );
            const totalM2 = round2(exclusiveM2 + sharedM2);
            hoBreakdown[hoNm] = {
              breakdown: hoRows.map(x => ({
                gb:          x.exposPubuseGbCdNm || codeToGb(x.exposPubuseGbCd),
                flrNm:       x.flrNoNm || (x.flrNo ? `지상${x.flrNo}층` : ""),
                use:         x.mainPurpsCdNm || x.etcPurps || "",
                area_m2:     toNumber(x.area),
                area_pyeong: round2(toNumber(x.area) / 3.305785),
              })),
              sum: {
                exclusive_m2:     exclusiveM2 || null,
                exclusive_pyeong: exclusiveM2 ? round2(exclusiveM2 / 3.305785) : null,
                shared_m2:        sharedM2    || null,
                shared_pyeong:    sharedM2    ? round2(sharedM2    / 3.305785) : null,
                total_m2:         totalM2     || null,
                total_pyeong:     totalM2     ? round2(totalM2     / 3.305785) : null,
              },
              source: "pubuse",
            };
          } else {
            // fallback: exposInfo
            const target = exposItems.find(it =>
              String(it.flrNo || "") === fNo &&
              normalizeHo(it.hoNm || "") === wantHoNorm
            );
            const areaM2 = target ? toNumber(target.area) : 0;
            if (areaM2 > 0) {
              hoBreakdown[hoNm] = {
                breakdown: [],
                sum: {
                  exclusive_m2:     areaM2,
                  exclusive_pyeong: round2(areaM2 / 3.305785),
                  shared_m2:        null,
                  shared_pyeong:    null,
                  total_m2:         areaM2,
                  total_pyeong:     round2(areaM2 / 3.305785),
                },
                source: "exposInfo_fallback",
              };
            } else {
              hoBreakdown[hoNm] = null; // 데이터 없음
            }
          }
        }

        floorsData[floorKey] = {
          floor_items:            floorItems.map(toClientFloorItem),
          pick:                   pick ? toClientFloorItem(pick) : null,
          ho_list:                hoList,
          ho_list_note:           hoNote,
          ho_index:               hoIndex,
          ho_breakdown:           hoBreakdown,
          floor_exclusive_m2:     floorExclusive?.m2 ?? null,
          floor_exclusive_pyeong: floorExclusive?.m2 ? round2(floorExclusive.m2 / 3.305785) : null,
          floor_exclusive_note:   floorExclusive?.note ?? null,
        };
      }

      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "all",
        input: { address },
        road:        j.roadAddr  || "",
        jibun:       j.jibunAddr || "",
        keys,
        floors:      floorList,
        floor_nos:   floorNos,
        floors_data: floorsData,
      });
    }

    // =====================================================
    // 기존 모드 (summary / floor / ho_breakdown)
    // =====================================================
    const floorNorm      = normalizeFloor(floorRaw);
    const effectiveFloor =
      floorNorm ||
      (floorList.find(f => f.gb === "지상")?.no ?? floorList[0]?.no ?? "");

    if (!floorRaw && !hoInput) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "summary",
        input: { address, floor: null, ho: null },
        road:      j.roadAddr  || "",
        jibun:     j.jibunAddr || "",
        keys,
        floors:    floorList,
        floor_nos: floorNos,
      });
    }

    if (!effectiveFloor) {
      return res.status(404).json({
        ok: false,
        build: BUILD,
        message: "층 정보를 찾지 못했습니다. (getBrFlrOulnInfo 결과 없음)",
        input: { address, floor: floorRaw, ho: hoInput },
        keys,
      });
    }

    const floorItems = flrItems.filter(it => String(it.flrNo || "") === String(effectiveFloor));
    const pick       = pickBestFloorItem(floorItems);

    if (debug) {
      const dbg = await debugHoSources(keys, effectiveFloor);
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "debug",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road:  j.roadAddr  || "",
        jibun: j.jibunAddr || "",
        keys,
        floor: String(effectiveFloor),
        debug: dbg,
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
        ok: true,
        build: BUILD,
        mode: "floor",
        input: { address, floor: effectiveFloor, ho: null },
        road:  j.roadAddr  || "",
        jibun: j.jibunAddr || "",
        keys,
        floor_nos:              floorNos,
        floor_items:            floorItems.map(toClientFloorItem),
        pick:                   pick ? toClientFloorItem(pick) : null,
        ho_list:                hoList,
        ho_list_note:           hoNote,
        ho_index:               hoIndex,
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
        gb:          x.exposPubuseGbCdNm || codeToGb(x.exposPubuseGbCd),
        flrNm:       x.flrNoNm || (x.flrNo ? `지상${x.flrNo}층` : ""),
        use:         x.mainPurpsCdNm || x.etcPurps || "",
        area_m2:     toNumber(x.area),
        area_pyeong: round2(toNumber(x.area) / 3.305785),
        raw: { flrNo: x.flrNo || "", hoNm: x.hoNm || "" },
      }));
      const sumArea = (pred) =>
        round2(hoRows.filter(pred).reduce((acc, it) => acc + toNumber(it.area), 0));
      const exclusiveM2 = sumArea(it =>
        String(it.exposPubuseGbCd || "") === "1" || String(it.exposPubuseGbCdNm || "").includes("전유")
      );
      const sharedM2 = sumArea(it =>
        String(it.exposPubuseGbCd || "") === "2" || String(it.exposPubuseGbCdNm || "").includes("공용")
      );
      const totalM2 = round2(exclusiveM2 + sharedM2);

      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "ho_breakdown",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road:  j.roadAddr  || "",
        jibun: j.jibunAddr || "",
        keys,
        ho_matched: { want: hoInput, wantHoNorm },
        breakdown,
        sum: {
          exclusive_m2:     exclusiveM2 || null,
          exclusive_pyeong: exclusiveM2 ? round2(exclusiveM2 / 3.305785) : null,
          shared_m2:        sharedM2    || null,
          shared_pyeong:    sharedM2    ? round2(sharedM2    / 3.305785) : null,
          total_m2:         totalM2     || null,
          total_pyeong:     totalM2     ? round2(totalM2     / 3.305785) : null,
        },
        note: "getBrExposPubuseAreaInfo 기준으로 호별 전유/공용을 구성했습니다.",
      });
    }

    const exposItems = await fetchBldItems("getBrExposInfo", keys);
    const target = exposItems.find(it =>
      String(it.flrNo || "") === String(effectiveFloor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm
    );
    const areaM2 = target ? toNumber(target.area) : 0;

    if (areaM2 > 0) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "exposInfo_fallback",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road:  j.roadAddr  || "",
        jibun: j.jibunAddr || "",
        keys,
        ho_matched: { hoNm: target.hoNm, flrNo: target.flrNo, dongNm: target.dongNm || "" },
        sum: {
          exclusive_m2:     areaM2,
          exclusive_pyeong: round2(areaM2 / 3.305785),
          shared_m2:        null,
          shared_pyeong:    null,
          total_m2:         areaM2,
          total_pyeong:     round2(areaM2 / 3.305785),
        },
        note: "전유/공용 breakdown 데이터가 없어서 전유부(getBrExposInfo) 면적으로 안내합니다.",
      });
    }

    const floorExclusive = findFloorExclusiveArea(pubItems, effectiveFloor);
    if (floorExclusive?.m2) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floorExclusive_fallback",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road:  j.roadAddr  || "",
        jibun: j.jibunAddr || "",
        keys,
        sum: {
          exclusive_m2:     floorExclusive.m2,
          exclusive_pyeong: round2(floorExclusive.m2 / 3.305785),
          shared_m2:        null,
          shared_pyeong:    null,
          total_m2:         floorExclusive.m2,
          total_pyeong:     round2(floorExclusive.m2 / 3.305785),
        },
        note: "해당 호 데이터가 공공API에서 누락되어, 같은 층의 '전유(hoNm 비어있는)' 면적으로 안내합니다.",
        floor_exclusive_note: floorExclusive.note,
      });
    }

    return res.status(404).json({
      ok: false,
      build: BUILD,
      message: "해당 층/호 면적 데이터를 공공API에서 찾지 못했습니다.",
      input: { address, floor: effectiveFloor, ho: hoInput },
      wantHoNorm,
      hint:
        "이 건물은 (1) 호 전유/공용이 API에 없거나, (2) 호 표기가 다르거나(예: 1306-1308, 1306-1), " +
        "(3) 앱은 내부/비공개 소스로 보완했을 수 있습니다. debug=1로 hoNm 형태를 점검해보세요.",
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
      String(xml).match(/<totalCount>(\d+)<\/totalCount>/)?.[1] || "0",
      10
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
    throw new Error(`${apiName} 호출 실패: API not found (엔드포인트 경로 확인 필요)`);
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
    gb:          it.flrGbCdNm       || "-",
    use:         it.mainPurpsCdNm   || "-",
    detail:      it.etcPurps        || "-",
    flrNo:       it.flrNo           || "",
    flrNoNm:     it.flrNoNm         || "",
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
        norm,
        samples:      [],
        hasExclusive: false,
        exclusive_m2: 0,
        shared_m2:    0,
        sources:      new Set(),
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
  } catch (e) {
    hoNote += `exposInfo 실패: ${e.message} `;
  }

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
        if (isExclusive) {
          hoIndex[norm].hasExclusive = true;
          hoIndex[norm].exclusive_m2 += a;
        } else if (isShared) {
          hoIndex[norm].shared_m2 += a;
        }
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
  } catch (e) {
    hoNote += `pubuseArea 실패: ${e.message} `;
  }

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
      note: `getBrExposPubuseAreaInfo: flrNo=${best.flrNo}, gb=${best.exposPubuseGbCdNm || best.exposPubuseGbCd}, hoNm="${best.hoNm || ""}"`,
    };
  } catch {
    return null;
  }
}

async function debugHoSources(keys, floor) {
  const out  = {};
  const apis = ["getBrExposInfo", "getBrExposPubuseAreaInfo", "getBrTitleInfo"];
  for (const apiName of apis) {
    try {
      const items      = await fetchBldItems(apiName, keys);
      const floorItems = items.filter(it => String(it.flrNo || "") === String(floor));
      out[apiName] = {
        total:       items.length,
        floorCount:  floorItems.length,
        hoNmSamples: floorItems.map(it => it.hoNm).filter(Boolean).slice(0, 80),
      };
    } catch (e) {
      out[apiName] = { error: e.message };
    }
  }
  return out;
}
