// api/area.js  (Node 18+ / Vercel Serverless)
const BUILD = "2025-12-28-HO-FIX-03";

module.exports = async (req, res) => {
  // ✅ CORS (티스토리/브라우저 fetch 필수)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const address = String(req.query.address || "").trim();
    const floorIn = req.query.floor != null ? String(req.query.floor).trim() : "";
    const hoIn = req.query.ho != null ? String(req.query.ho).trim() : "";

    if (!address) return res.status(400).json({ ok: false, build: BUILD, message: "address 파라미터가 필요합니다." });
    if (!process.env.JUSO_KEY) return res.status(500).json({ ok: false, build: BUILD, message: "JUSO_KEY 환경변수가 없습니다." });
    if (!process.env.BLD_KEY) return res.status(500).json({ ok: false, build: BUILD, message: "BLD_KEY(건축HUB serviceKey) 환경변수가 없습니다." });

    // 1) 주소 → 지번키(sigungu/bjdong/bun/ji)
    const j = await jusoLookup(address);
    const admCd = j.admCd; // 10자리
    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd = admCd.slice(5, 10);
    const bun = String(j.lnbrMnnm).padStart(4, "0");
    const ji = String(j.lnbrSlno).padStart(4, "0");
    const baseKeys = { sigunguCd, bjdongCd, bun, ji };

    // 2) 층별현황 (실제 존재 층 만들기)
    const flrItems = await callHubItems("getBrFlrOulnInfo", { sigunguCd, bjdongCd, bun, ji });
    const floorList = buildFloorList(flrItems);

    const effectiveFloor =
      floorIn ||
      (floorList.find(f => f.gb.includes("지상"))?.no ?? floorList[0]?.no ?? "1");

    const floorItems = flrItems.filter(it => String(it.flrNo) === String(effectiveFloor));
    const pick = pickBestFloorItem(floorItems);

    // 3) 호 목록(전유 여부 포함) + (필요시) 호 면적
    //    핵심: getBrExposPubuseAreaInfo로 호 목록을 만든다
    const pubItems = await callHubItems("getBrExposPubuseAreaInfo", { sigunguCd, bjdongCd, bun, ji });

    const hoIndex = buildHoIndexFromPubuse(pubItems, effectiveFloor);
    // hoIndex.list: [{hoKey, labels:Set, hasExclusive, exclusiveAreaM2?}, ...]
    // hoIndex.allLabels: ["1209호", "1209-1호", ...]

    // ✅ 호 요청이 없으면: 층 + 호목록(전유가능/불가 표시) 반환
    if (!hoIn) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floorItems+hoIndex",
        input: { address, floor: effectiveFloor, ho: null },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        floor_list: floorList,
        floor_items: floorItems.map(toClientFloorItem),
        pick: pick ? toClientFloorItem(pick) : null,
        ho_list: hoIndex.list.map(x => ({
          ho: x.hoKey,                    // 예: "1210" (정규화 키)
          label: pickLabel(x.labels),     // 예: "1210호" 또는 "1210-1호"
          has_exclusive: x.hasExclusive,  // 전유(1) 존재 여부
        })),
        ho_list_note: hoIndex.note,
      });
    }

    // ✅ 호 면적 요청
    const wantKey = normalizeHoKey(hoIn);     // "1210호", "1210-1" => "1210" or "1210-1"
    const cand = hoIndex.map.get(wantKey);

    // (A) 호 자체가 pubuse 목록에 없다면: "표기" 차이일 수 있으니 느슨 매칭도 시도
    let matchKey = wantKey;
    if (!cand) {
      const loose = findLooseHoKey(hoIndex.map, hoIn);
      if (loose) matchKey = loose;
    }

    const target = hoIndex.map.get(matchKey);

    if (!target) {
      return res.status(404).json({
        ok: false,
        build: BUILD,
        message: "해당 층/호를 호별 목록에서 찾지 못했습니다. (호 표기 확인 필요)",
        input: { address, floor: effectiveFloor, ho: hoIn },
        wantKey,
        hint: "예: 1209 / 1209호 / 1209-1 / 1209-1호 처럼 표기가 다를 수 있어요.",
        sample_ho: hoIndex.list.slice(0, 50).map(x => [...x.labels][0]),
      });
    }

    // (B) 전유(1) 면적 우선
    const exclu = pickExclusiveFromPubuse(pubItems, effectiveFloor, matchKey);

    if (!exclu) {
      return res.status(200).json({
        ok: false,
        build: BUILD,
        message: "이 호는 공공 API에 '전유(1)' 면적이 없습니다. (공용 항목만 존재)",
        input: { address, floor: effectiveFloor, ho: hoIn },
        ho_key: matchKey,
        labels: [...target.labels],
        hint: "해당 건물/호는 전유부가 API에 미제공일 수 있습니다. (앱/민간 DB와 다를 수 있음)",
      });
    }

    const areaM2 = exclu.areaM2;
    return res.status(200).json({
      ok: true,
      build: BUILD,
      mode: "pubuse-exclusive",
      input: { address, floor: effectiveFloor, ho: hoIn },
      jibun: j.jibunAddr,
      road: j.roadAddr,
      keys: baseKeys,
      ho_key: matchKey,
      ho_labels: [...target.labels],
      area_m2: areaM2,
      area_pyeong: round2(areaM2 / 3.305785),
      note: "getBrExposPubuseAreaInfo에서 전유(1) 면적 사용",
    });

  } catch (e) {
    return res.status(500).json({ ok: false, build: BUILD, message: e.message });
  }
};

/* ------------------ API helpers ------------------ */

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

async function callHubItems(opName, { sigunguCd, bjdongCd, bun, ji }) {
  const url = new URL(`https://apis.data.go.kr/1613000/BldRgstHubService/${opName}`);
  url.searchParams.set("serviceKey", process.env.BLD_KEY);
  url.searchParams.set("sigunguCd", sigunguCd);
  url.searchParams.set("bjdongCd", bjdongCd);
  url.searchParams.set("bun", bun);
  url.searchParams.set("ji", ji);
  url.searchParams.set("numOfRows", "9999");
  url.searchParams.set("pageNo", "1");

  const xml = await (await fetch(url.toString())).text();
  assertApiOk(xml, opName);
  return parseItems(xml).map(itemXmlToObj);
}

function assertApiOk(xml, apiName) {
  const resultCode = getTag(xml, "resultCode");
  const resultMsg = getTag(xml, "resultMsg");
  if (resultCode && resultCode !== "00") {
    throw new Error(`${apiName} 실패: ${resultCode} / ${resultMsg || ""}`.trim());
  }
}

function parseItems(xmlText) {
  return [...xmlText.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}

function getTag(xmlChunk, tag) {
  const m = xmlChunk.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}

function itemXmlToObj(xmlChunk) {
  const tags = [
    "flrGbCdNm", "flrNo", "flrNoNm",
    "mainPurpsCdNm", "etcPurps",
    "exposPubuseGbCd", "exposPubuseGbCdNm",
    "dongNm", "hoNm",
    "area",
  ];
  const obj = {};
  for (const t of tags) obj[t] = getTag(xmlChunk, t);
  return obj;
}

function toNumber(v) {
  const n = Number(String(v || "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

/* ------------------ floor helpers ------------------ */

function buildFloorList(flrItems) {
  const seen = new Set();
  const list = [];
  for (const it of flrItems || []) {
    const gb = (it.flrGbCdNm || "").trim();   // 지상/지하
    const no = String(it.flrNo || "").trim();
    if (!no) continue;
    const key = `${gb}:${no}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ gb: gb || "", no });
  }
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

function toClientFloorItem(it) {
  const areaM2 = toNumber(it.area);
  return {
    gb: it.flrGbCdNm || "",
    use: it.mainPurpsCdNm || "",
    detail: it.etcPurps || "",
    flrNo: it.flrNo || "",
    area_m2: areaM2,
    area_pyeong: round2(areaM2 / 3.305785),
  };
}

function pickBestFloorItem(items) {
  if (!items || !items.length) return null;
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
  if (s.includes("공용")) return 1;
  if (s.includes("계단") || s.includes("승강기") || s.includes("복도")) return 1;
  if (s.includes("사무") || s.includes("업무") || s.includes("근린")) return 3;
  return 2;
}

/* ------------------ ho helpers ------------------ */

// ✅ "1210호", "1210-1호", " 1210-1 " -> "1210" or "1210-1"
function normalizeHoKey(s) {
  const t = String(s || "").replace(/\s+/g, "");
  const m = t.match(/(\d+)(-\d+)?/);
  return m ? (m[1] + (m[2] || "")) : "";
}

function buildHoIndexFromPubuse(pubItems, floorNo) {
  const map = new Map(); // key -> {labels:Set, hasExclusive:boolean}
  let note = "";

  const floorItems = (pubItems || []).filter(it => String(it.flrNo || "") === String(floorNo));

  for (const it of floorItems) {
    const raw = String(it.hoNm || "").trim();
    const key = normalizeHoKey(raw);
    if (!key) continue;

    if (!map.has(key)) map.set(key, { hoKey: key, labels: new Set(), hasExclusive: false });
    const entry = map.get(key);
    entry.labels.add(raw);

    const gbCd = String(it.exposPubuseGbCd || "").trim();
    const gbNm = String(it.exposPubuseGbCdNm || "").trim();
    const isExclusive = (gbCd === "1") || gbNm.includes("전유");
    if (isExclusive) entry.hasExclusive = true;
  }

  const list = [...map.values()].sort((a, b) => {
    // 숫자 비교 + -suffix 비교
    const [an, as] = splitHoKey(a.hoKey);
    const [bn, bs] = splitHoKey(b.hoKey);
    if (an !== bn) return an - bn;
    return as - bs;
  });

  if (!list.length) note = "해당 층에서 호 목록을 만들지 못했습니다(공공API 호별 데이터 없음).";

  return { map, list, note };
}

function splitHoKey(key) {
  const m = String(key).match(/^(\d+)(?:-(\d+))?$/);
  const n = m ? Number(m[1]) : 0;
  const s = m && m[2] ? Number(m[2]) : 0;
  return [n, s];
}

function pickLabel(labelsSet) {
  // "1210호" 같이 보이게 우선
  const arr = [...labelsSet];
  const withHo = arr.find(x => x.includes("호"));
  return withHo || arr[0] || "";
}

function findLooseHoKey(map, hoIn) {
  const k = normalizeHoKey(hoIn);
  if (k && map.has(k)) return k;

  // "1210호" vs "1210" 같은 단순차
  const digits = (String(hoIn).match(/\d+/)?.[0]) || "";
  if (!digits) return "";

  // 같은 digits로 시작하는 key 찾기(예: 1210-1)
  for (const key of map.keys()) {
    if (key === digits) return key;
  }
  for (const key of map.keys()) {
    if (key.startsWith(digits + "-")) return key;
  }
  return "";
}

function pickExclusiveFromPubuse(pubItems, floorNo, hoKey) {
  const items = (pubItems || []).filter(it =>
    String(it.flrNo || "") === String(floorNo) &&
    normalizeHoKey(it.hoNm || "") === String(hoKey)
  );

  // 전유(1)만
  const exclu = items.find(it => String(it.exposPubuseGbCd || "").trim() === "1" || String(it.exposPubuseGbCdNm || "").includes("전유"));
  if (!exclu) return null;

  const areaM2 = toNumber(exclu.area);
  if (!(areaM2 > 0)) return null;

  return { areaM2, raw: exclu };
}
