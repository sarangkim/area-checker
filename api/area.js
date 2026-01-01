// api/area.js
// Vercel Serverless Function (Node 18+)
// env: JUSO_KEY, BLD_KEY
//
// 기능 요약
// - address만: 도로명/지번/키 + 층 목록(floor_nos) 제공
// - address+floor: 해당 층 floor_items + 해당 층 ho_list + ho_index(전유유무 등) + (있으면) floor_exclusive 제공
// - address+floor+ho: 해당 호의 전유/공용 breakdown 제공(스마트국토정보 앱 스타일)
// - debug=1: 해당 층에서 API별 hoNm 샘플 확인

const BUILD = "2025-12-30-HO-DETAIL-01";

module.exports = async (req, res) => {
  // ---- CORS ----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const address = String(req.query.address || "").trim();
    const floorRaw = req.query.floor != null ? String(req.query.floor).trim() : "";
    const hoInput = req.query.ho != null ? String(req.query.ho).trim() : "";
    const debug = String(req.query.debug || "").trim() === "1";

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

    const admCd = String(j.admCd || "");
    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd = admCd.slice(5, 10);
    const bun = String(j.lnbrMnnm).padStart(4, "0");
    const ji = String(j.lnbrSlno).padStart(4, "0");
    const keys = { sigunguCd, bjdongCd, bun, ji };

    // 2) 층별현황 (getBrFlrOulnInfo)
    const flrItems = await fetchBldItems("getBrFlrOulnInfo", keys);
    const floorList = buildFloorList(flrItems);     // [{gb,no}]
    const floorNos = floorList.map(x => String(x.no)); // ✅ 프론트에서 버튼 만들기 쉬운 순수 숫자 배열

    const floorNorm = normalizeFloor(floorRaw);
    const effectiveFloor =
      floorNorm ||
      (floorList.find(f => f.gb === "지상")?.no ?? floorList[0]?.no ?? "");

    // address만 들어온 경우(요약만)
    if (!floorRaw && !hoInput) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "summary",
        input: { address, floor: null, ho: null },
        road: j.roadAddr || "",
        jibun: j.jibunAddr || "",
        keys,
        floors: floorList,     // 필요하면 쓰세요(객체)
        floor_nos: floorNos,   // ✅ 프론트는 이걸 쓰면 [object Object] 문제 없음
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

    // 해당 층 item들
    const floorItems = flrItems.filter(it => String(it.flrNo || "") === String(effectiveFloor));
    const pick = pickBestFloorItem(floorItems);

    // debug=1이면: API별로 해당 층의 hoNm이 어떤 형태로 오는지 빠르게 확인
    if (debug) {
      const dbg = await debugHoSources(keys, effectiveFloor);
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "debug",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road: j.roadAddr || "",
        jibun: j.jibunAddr || "",
        keys,
        floor: String(effectiveFloor),
        debug: dbg,
      });
    }

    // 3) (층만 조회) => floor_items + 해당 층 ho_list + ho_index + (있으면) floor_exclusive
    if (!hoInput) {
      const { hoList, hoNote, hoIndex } = await collectHoListForFloor(keys, effectiveFloor);
      const floorExclusive = await findFloorExclusiveArea(keys, effectiveFloor);

      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floor",
        input: { address, floor: effectiveFloor, ho: null },
        road: j.roadAddr || "",
        jibun: j.jibunAddr || "",
        keys,
        floor_nos: floorNos,

        floor_items: floorItems.map(toClientFloorItem),
        pick: pick ? toClientFloorItem(pick) : null,

        // ✅ 이 ho_list는 "해당 층만" 들어있게 강제
        ho_list: hoList,
        ho_list_note: hoNote,
        ho_index: hoIndex, // { "1306": { hasExclusive, exclusive_m2, shared_m2, ... } }

        floor_exclusive_m2: floorExclusive?.m2 ?? null,
        floor_exclusive_pyeong: floorExclusive?.m2 ? round2(floorExclusive.m2 / 3.305785) : null,
        floor_exclusive_note: floorExclusive?.note ?? null,
      });
    }

    // 4) (호 조회) => 스마트국토정보 앱처럼 전유/공용 현황 breakdown
    const wantHoNorm = normalizeHo(hoInput);

    // 4-A) 전유/공용(getBrExposPubuseAreaInfo)에서 해당 호 레코드 전부 긁어서 전유/공용 표로 반환
    const pubItems = await fetchBldItems("getBrExposPubuseAreaInfo", keys);

    // 1차: 정규화 동일 매칭
    let hoRows = pubItems.filter(it =>
      String(it.flrNo || "") === String(effectiveFloor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm
    );

    // 2차: 포함 매칭(예: "1306-1308" 같이 들어오는 케이스 대비)
    if (!hoRows.length) {
      hoRows = pubItems.filter(it => {
        if (String(it.flrNo || "") !== String(effectiveFloor)) return false;
        const raw = String(it.hoNm || "").trim();
        if (!raw) return false;
        // 숫자 경계 포함 여부(1306이 21306에 매칭되는 것 방지)
        return new RegExp(`(^|[^0-9])${escapeReg(wantHoNorm)}([^0-9]|$)`).test(raw);
      });
    }

    // 전유/공용 합계 및 표 행
    if (hoRows.length) {
      const breakdown = hoRows.map(x => ({
        gb: x.exposPubuseGbCdNm || codeToGb(x.exposPubuseGbCd),
        flrNm: x.flrNoNm || (x.flrNo ? `지상${x.flrNo}층` : ""),
        structure: x.strctCdNm || x.strctCd || "",   // (있으면)
        use: x.mainPurpsCdNm || x.etcPurps || "",
        area_m2: toNumber(x.area),
        area_pyeong: round2(toNumber(x.area) / 3.305785),
        raw: { flrNo: x.flrNo || "", hoNm: x.hoNm || "" },
      }));

      const sum = (pred) =>
        round2(hoRows.filter(pred).reduce((acc, it) => acc + toNumber(it.area), 0));

      const exclusiveM2 = sum(it =>
        String(it.exposPubuseGbCd || "") === "1" || String(it.exposPubuseGbCdNm || "").includes("전유")
      );
      const sharedM2 = sum(it =>
        String(it.exposPubuseGbCd || "") === "2" || String(it.exposPubuseGbCdNm || "").includes("공용")
      );
      const totalM2 = round2(exclusiveM2 + sharedM2);

      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "ho_breakdown",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road: j.roadAddr || "",
        jibun: j.jibunAddr || "",
        keys,
        ho_matched: { want: hoInput, wantHoNorm },
        breakdown,
        sum: {
          exclusive_m2: exclusiveM2 || null,
          exclusive_pyeong: exclusiveM2 ? round2(exclusiveM2 / 3.305785) : null,
          shared_m2: sharedM2 || null,
          shared_pyeong: sharedM2 ? round2(sharedM2 / 3.305785) : null,
          total_m2: totalM2 || null,
          total_pyeong: totalM2 ? round2(totalM2 / 3.305785) : null,
        },
        note: "getBrExposPubuseAreaInfo 기준으로 호별 전유/공용을 구성했습니다.",
      });
    }

    // 4-B) 전유부(getBrExposInfo) fallback (pubuse에 호가 없을 때)
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
        road: j.roadAddr || "",
        jibun: j.jibunAddr || "",
        keys,
        ho_matched: { hoNm: target.hoNm, flrNo: target.flrNo, dongNm: target.dongNm || "" },
        sum: {
          exclusive_m2: areaM2,
          exclusive_pyeong: round2(areaM2 / 3.305785),
          shared_m2: null,
          shared_pyeong: null,
          total_m2: areaM2,
          total_pyeong: round2(areaM2 / 3.305785),
        },
        note: "전유/공용 breakdown 데이터가 없어서 전유부(getBrExposInfo) 면적으로 안내합니다.",
      });
    }

    // 4-C) 그래도 없으면 "층 전유(hoNm 없음)" 안내
    const floorExclusive = await findFloorExclusiveArea(keys, effectiveFloor);
    if (floorExclusive?.m2) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floorExclusive_fallback",
        input: { address, floor: effectiveFloor, ho: hoInput },
        road: j.roadAddr || "",
        jibun: j.jibunAddr || "",
        keys,
        sum: {
          exclusive_m2: floorExclusive.m2,
          exclusive_pyeong: round2(floorExclusive.m2 / 3.305785),
          shared_m2: null,
          shared_pyeong: null,
          total_m2: floorExclusive.m2,
          total_pyeong: round2(floorExclusive.m2 / 3.305785),
        },
        note:
          "해당 호 데이터가 공공API에서 누락되어, 같은 층의 '전유(hoNm 비어있는)' 면적으로 안내합니다. " +
          "이 경우 스마트국토정보 앱도 '호'가 실질적으로 층 전유 단위로만 제공되는 케이스일 수 있습니다.",
        floor_exclusive_note: floorExclusive.note,
      });
    }

    // 최종 실패
    return res.status(404).json({
      ok: false,
      build: BUILD,
      message: "해당 층/호 면적 데이터를 공공API에서 찾지 못했습니다.",
      input: { address, floor: effectiveFloor, ho: hoInput },
      wantHoNorm,
      hint:
        "이 건물은 (1) 호 전유/공용이 API에 없거나, (2) 호 표기가 다르거나(예: 1306-1308, 1306-1), " +
        "(3) 앱은 내부/비공개 소스(또는 다른 엔드포인트)로 보완했을 수 있습니다. debug=1로 hoNm 형태를 점검해보세요.",
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
  return j;
}

async function fetchBldItems(apiName, keys) {
  const url = new URL(`https://apis.data.go.kr/1613000/BldRgstHubService/${apiName}`);
  url.searchParams.set("serviceKey", process.env.BLD_KEY);
  url.searchParams.set("sigunguCd", keys.sigunguCd);
  url.searchParams.set("bjdongCd", keys.bjdongCd);
  url.searchParams.set("bun", keys.bun);
  url.searchParams.set("ji", keys.ji);
  url.searchParams.set("numOfRows", "9999");
  url.searchParams.set("pageNo", "1");

  const xml = await (await fetch(url.toString())).text();
  assertApiOk(xml, apiName);
  return parseItems(xml).map(itemXmlToObj);
}

function parseItems(xmlText) {
  return [...String(xmlText || "").matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}

function getTag(xmlChunk, tag) {
  const m = String(xmlChunk || "").match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}

function itemXmlToObj(item) {
  // API마다 태그가 조금씩 다를 수 있어 넉넉하게
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
  const resultMsg  = String(xmlText || "").match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1]?.trim() || "";
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
  // "1209호", "1209", "1209-1", "1209~1210" => "1209" (첫 숫자만)
  const m = String(s || "").match(/\d+/);
  return m ? m[0] : "";
}

function normalizeFloor(s) {
  const m = String(s || "").match(/-?\d+/);
  return m ? String(Number(m[0])) : "";
}

function buildFloorList(flrItems) {
  const map = new Map(); // key: `${gb}:${no}`
  for (const it of flrItems || []) {
    const no = normalizeFloor(it.flrNo || "");
    if (!no) continue;
    const gb = (it.flrGbCdNm || "").includes("지하") ? "지하" : "지상";
    const key = `${gb}:${no}`;
    if (!map.has(key)) map.set(key, { gb, no: String(no) });
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
    const txt = `${it.mainPurpsCdNm || ""} ${it.etcPurps || ""}`.trim();
    let s = area;
    if (txt.includes("공용")) s -= 100000;
    if (txt.includes("업무") || txt.includes("사무")) s += 50000;
    return s;
  };
  return items.slice().sort((a, b) => score(b) - score(a))[0];
}

// ✅ 프론트 표(구분/용도/세부)에 바로 들어가게 필드명 맞춤
function toClientFloorItem(it) {
  const areaM2 = toNumber(it.area);
  return {
    gb: it.flrGbCdNm || "-",                  // 구분
    use: it.mainPurpsCdNm || "-",             // 용도
    detail: it.etcPurps || "-",               // 세부
    flrNo: it.flrNo || "",
    flrNoNm: it.flrNoNm || "",
    area_m2: areaM2,
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

async function collectHoListForFloor(keys, floor) {
  const hoSet = new Set();     // 원본 hoNm
  const hoIndex = {};          // normalizeHo 기준 인덱스
  let hoNote = "";

  // helper: add ho
  const addHo = (hoNm, src) => {
    const raw = String(hoNm || "").trim();
    if (!raw) return;
    hoSet.add(raw);

    const norm = normalizeHo(raw);
    if (!norm) return;

    if (!hoIndex[norm]) {
      hoIndex[norm] = {
        norm,
        samples: [],
        hasExclusive: false,
        exclusive_m2: 0,
        shared_m2: 0,
        sources: new Set(),
      };
    }
    const idx = hoIndex[norm];
    idx.sources.add(src);
    if (idx.samples.length < 5 && !idx.samples.includes(raw)) idx.samples.push(raw);
  };

  // (A) getBrExposInfo
  try {
    const exposItems = await fetchBldItems("getBrExposInfo", keys);
    exposItems
      .filter(it => String(it.flrNo || "") === String(floor))
      .forEach(it => addHo(it.hoNm, "exposInfo"));
  } catch (e) {
    hoNote += `exposInfo 실패: ${e.message} `;
  }

  // (B) getBrExposPubuseAreaInfo (전유/공용) — 여기서 전유/공용 여부도 hoIndex에 채움
  try {
    const pubItems = await fetchBldItems("getBrExposPubuseAreaInfo", keys);
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

    // 합계 round
    Object.values(hoIndex).forEach(v => {
      v.exclusive_m2 = round2(v.exclusive_m2);
      v.shared_m2 = round2(v.shared_m2);
      v.total_m2 = round2(v.exclusive_m2 + v.shared_m2);
      v.exclusive_pyeong = v.exclusive_m2 ? round2(v.exclusive_m2 / 3.305785) : null;
      v.shared_pyeong = v.shared_m2 ? round2(v.shared_m2 / 3.305785) : null;
      v.total_pyeong = v.total_m2 ? round2(v.total_m2 / 3.305785) : null;
      v.sources = [...v.sources];
    });
  } catch (e) {
    hoNote += `pubuseArea 실패: ${e.message} `;
  }

  // (C) 선택사항: getBrTitleInfo — 존재하지 않는 API일 수 있어 실패해도 OK
  try {
    const titleItems = await fetchBldItems("getBrTitleInfo", keys);
    titleItems
      .filter(it => String(it.flrNo || "") === String(floor))
      .forEach(it => addHo(it.hoNm, "titleInfo"));
  } catch (e) {
    // 조용히 무시(환경마다 API가 막혀 있거나 미지원일 수 있음)
  }

  // ✅ hoList는 “정규화 숫자 기준”으로 정렬해서 프론트 드롭다운이 깔끔해짐
  const hoList = [...hoSet].sort((a, b) => {
    const na = Number(normalizeHo(a)) || 0;
    const nb = Number(normalizeHo(b)) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "ko");
  });

  if (!hoList.length) hoNote = (hoNote || "") + "해당 층에서 호 목록을 찾지 못했습니다.";

  return { hoList, hoNote: hoNote.trim(), hoIndex };
}

async function findFloorExclusiveArea(keys, floor) {
  // getBrExposPubuseAreaInfo에서:
  // - flrNo=층
  // - 전유(1)
  // - hoNm이 비어있거나 숫자가 안 잡히는 케이스(층 전유)
  try {
    const pubItems = await fetchBldItems("getBrExposPubuseAreaInfo", keys);
    const candidates = pubItems.filter(it => {
      if (String(it.flrNo || "") !== String(floor)) return false;

      const isExclusive =
        String(it.exposPubuseGbCd || "") === "1" ||
        String(it.exposPubuseGbCdNm || "").includes("전유");
      if (!isExclusive) return false;

      const hoNorm = normalizeHo(it.hoNm || "");
      const hoRaw = String(it.hoNm || "").trim();
      return !hoRaw || !hoNorm;
    });

    if (!candidates.length) return null;
    candidates.sort((a, b) => (toNumber(b.area) || 0) - (toNumber(a.area) || 0));
    const best = candidates[0];
    const m2 = toNumber(best.area);
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
  const out = {};
  const apis = ["getBrExposInfo", "getBrExposPubuseAreaInfo", "getBrTitleInfo"];
  for (const api of apis) {
    try {
      const items = await fetchBldItems(api, keys);
      const floorItems = items.filter(it => String(it.flrNo || "") === String(floor));
      out[api] = {
        total: items.length,
        floorCount: floorItems.length,
        hoNmSamples: floorItems.map(it => it.hoNm).filter(Boolean).slice(0, 80),
      };
    } catch (e) {
      out[api] = { error: e.message };
    }
  }
  return out;
}
