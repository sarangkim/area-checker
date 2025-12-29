// api/area.js
// Vercel Serverless Function (Node 18+)
// env: JUSO_KEY, BLD_KEY

const BUILD = "2025-12-29-HO-FIX-01";

/* ----------------- main handler ----------------- */
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
    const flrItems = await fetchBldItems("getBrFlrOulnInfo", {
      sigunguCd, bjdongCd, bun, ji,
    });

    // 실제 존재 층 목록 구성
    const floorList = buildFloorList(flrItems);

    // 사용자가 "10층" 같이 넣어도 숫자만 뽑아 처리
    const floorNorm = normalizeFloor(floorRaw);
    const effectiveFloor =
      floorNorm ||
      (floorList.find(f => f.gb === "지상")?.no ?? floorList[0]?.no ?? "");

    if (!effectiveFloor) {
      return res.status(404).json({
        ok: false,
        build: BUILD,
        message: "층 정보를 찾지 못했습니다. (getBrFlrOulnInfo 결과 없음)",
        input: { address, floor: floorRaw, ho: hoInput },
        keys,
      });
    }

    // 해당 층 item들 + pick(대표)
    const floorItems = flrItems.filter(it => String(it.flrNo || "") === String(effectiveFloor));
    const pick = pickBestFloorItem(floorItems);

    // 3) (층만 조회) 호 목록 + (있으면) 층 전유 면적까지 같이 내려줌
    if (!hoInput) {
      // 3-A) 호 목록(해당 층만!) 수집
      const { hoList, hoNote } = await collectHoListForFloor(keys, effectiveFloor);

      // 3-B) 스마트국토정보 앱처럼 "층 전유"가 API에 있는 경우가 있음(hoNm이 비어있음)
      // getBrExposPubuseAreaInfo에서 flrNo=층, gb=전유(1), hoNm이 비거나 0/NULL인 케이스
      const floorExclusive = await findFloorExclusiveArea(keys, effectiveFloor);

      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floorItems+hoList+floorExclusive",
        input: { address, floor: effectiveFloor, ho: null },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys,

        floors: floorList, // 버튼 만들 때 쓰기 좋게 전체 층 제공(원하면 프론트에서 사용)
        floor_items: floorItems.map(toClientFloorItem),
        pick: pick ? toClientFloorItem(pick) : null,

        // ✅ 드롭다운은 이 ho_list만 쓰면 됨(해당 층만 들어있음)
        ho_list: hoList,
        ho_list_note: hoNote,

        // ✅ (있으면) 층 전유면적(앱에서 보이는 전유)
        floor_exclusive_m2: floorExclusive?.m2 ?? null,
        floor_exclusive_pyeong: floorExclusive?.m2 ? round2(floorExclusive.m2 / 3.305785) : null,
        floor_exclusive_note: floorExclusive?.note ?? null,
      });
    }

    // 4) (호 조회) 전유부 우선: getBrExposInfo → 없으면 getBrExposPubuseAreaInfo
    const wantHoNorm = normalizeHo(hoInput);

    // 4-A) 전유부(getBrExposInfo)에서 먼저 찾기
    const exposItems = await fetchBldItems("getBrExposInfo", keys);
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
        keys,
        ho_matched: { hoNm: target.hoNm, flrNo: target.flrNo, dongNm: target.dongNm || "" },
        area_m2: areaM2,
        area_pyeong: round2(areaM2 / 3.305785),
        note: "전유부(getBrExposInfo)의 area 사용",
      });
    }

    // 4-B) 전유/공용(getBrExposPubuseAreaInfo)에서 찾기(전유 우선, 없으면 max(area))
    const pubItems = await fetchBldItems("getBrExposPubuseAreaInfo", keys);

    const matches = pubItems.filter(it =>
      String(it.flrNo || "") === String(effectiveFloor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm
    );

    let best = matches.find(it =>
      String(it.exposPubuseGbCd || "") === "1" ||
      String(it.exposPubuseGbCdNm || "").includes("전유")
    );
    if (!best && matches.length) {
      best = matches.slice().sort((a, b) => (toNumber(b.area) || 0) - (toNumber(a.area) || 0))[0];
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
        keys,
        ho_matched: { hoNm: best.hoNm, flrNo: best.flrNo, dongNm: best.dongNm || "" },
        area_m2: areaM2,
        area_pyeong: round2(areaM2 / 3.305785),
        note: `getBrExposPubuseAreaInfo 사용 (구분=${gb || "미상"})`,
        debug: {
          matched_count: matches.length,
          used_rule:
            (String(best.exposPubuseGbCd || "") === "1" || String(best.exposPubuseGbCdNm || "").includes("전유"))
              ? "전유 우선"
              : "전유 없음 → max(area) fallback",
        },
      });
    }

    // 4-C) 그래도 못 찾으면: (앱에선 보이는데 ho가 없는 케이스) "층 전유"로 안내
    const floorExclusive = await findFloorExclusiveArea(keys, effectiveFloor);
    if (floorExclusive?.m2) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floorExclusive fallback",
        input: { address, floor: effectiveFloor, ho: hoInput },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys,
        area_m2: floorExclusive.m2,
        area_pyeong: round2(floorExclusive.m2 / 3.305785),
        note: "해당 호 전유가 공공API에 없어서, 같은 층의 '전유(hoNm 비어있는)' 면적으로 안내합니다.",
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
      hint: "이 건물은 호 전유가 API에 없거나, 호 표기가 다를 수 있습니다(예: 1209호/1209-1). 또는 앱은 '층 전유(ho 없음)'만 제공하는 케이스일 수 있습니다.",
      pubuse_samples: matches.slice(0, 50).map(x => ({
        flrNo: x.flrNo, hoNm: x.hoNm, gb: x.exposPubuseGbCdNm, area: x.area
      })),
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
  // "1209호", "1209", "1209-1" => "1209" (첫 숫자만)
  const m = String(s || "").match(/\d+/);
  return m ? m[0] : "";
}

function normalizeFloor(s) {
  // "10", "10층", "지상10" 등 -> "10"
  const m = String(s || "").match(/-?\d+/);
  return m ? String(Number(m[0])) : "";
}

function buildFloorList(flrItems) {
  // flrGbCdNm이 '지상'/'지하'로 오는 경우가 많음
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
    // 지하 먼저(원하면 바꿔도 됨)
    if (a.gb !== b.gb) return a.gb === "지하" ? -1 : 1;
    return Number(a.no) - Number(b.no);
  });
  return arr;
}

function pickBestFloorItem(items) {
  if (!items || !items.length) return null;

  // 공용 시설은 감점, 업무/사무 느낌은 가점, 기본은 area 큰 것 우선
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

async function collectHoListForFloor(keys, floor) {
  const hoSet = new Set();
  let hoNote = "";

  // (A) getBrExposInfo에서 호 수집
  try {
    const exposItems = await fetchBldItems("getBrExposInfo", keys);
    exposItems
      .filter(it => String(it.flrNo || "") === String(floor))
      .map(it => (it.hoNm || "").trim())
      .filter(Boolean)
      .forEach(h => hoSet.add(h));
  } catch (e) {
    hoNote += `exposInfo 호수집 실패: ${e.message} `;
  }

  // (B) getBrExposPubuseAreaInfo에서도 호 수집(누락 보완)
  try {
    const pubItems = await fetchBldItems("getBrExposPubuseAreaInfo", keys);
    pubItems
      .filter(it => String(it.flrNo || "") === String(floor))
      .map(it => (it.hoNm || "").trim())
      .filter(Boolean)
      .forEach(h => hoSet.add(h));
  } catch (e) {
    hoNote += `pubuseArea 호수집 실패: ${e.message} `;
  }

  // ✅ 여기서 “다른 층”이 섞이는 문제는 반드시 이 floor 필터가 깨졌을 때 생깁니다.
  // 위에서 floor 필터로만 set에 넣기 때문에, ho_list는 해당 층만 나옵니다.

  const hoList = [...hoSet].sort((a, b) => {
    const na = Number(normalizeHo(a)) || 0;
    const nb = Number(normalizeHo(b)) || 0;
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "ko");
  });

  if (!hoList.length) {
    hoNote = (hoNote || "") + "해당 층에서 호 목록을 찾지 못했습니다.";
  }
  return { hoList, hoNote: hoNote.trim() };
}

async function findFloorExclusiveArea(keys, floor) {
  // getBrExposPubuseAreaInfo에서:
  // - flrNo=층
  // - 전유(1)
  // - hoNm이 비어있거나 숫자가 없는 케이스(층 전유)
  try {
    const pubItems = await fetchBldItems("getBrExposPubuseAreaInfo", keys);
    const candidates = pubItems.filter(it => {
      if (String(it.flrNo || "") !== String(floor)) return false;

      const isExclusive =
        String(it.exposPubuseGbCd || "") === "1" ||
        String(it.exposPubuseGbCdNm || "").includes("전유");

      if (!isExclusive) return false;

      // hoNm이 없거나(빈문자/공백) 숫자가 안 잡히면 '층 전유' 후보로 간주
      const hoNorm = normalizeHo(it.hoNm || "");
      const hoRaw = String(it.hoNm || "").trim();
      return !hoRaw || !hoNorm;
    });

    if (!candidates.length) return null;

    // 면적 큰 값 우선
    candidates.sort((a, b) => (toNumber(b.area) || 0) - (toNumber(a.area) || 0));
    const best = candidates[0];
    const m2 = toNumber(best.area);

    if (!m2) return null;
    return {
      m2,
      note: `getBrExposPubuseAreaInfo: flrNo=${best.flrNo}, gb=${best.exposPubuseGbCdNm || best.exposPubuseGbCd}, hoNm="${best.hoNm || ""}"`,
    };
  } catch (e) {
    return null;
  }
}
