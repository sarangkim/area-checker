// /api/area.js
// Vercel Serverless Function (Node.js)
// env: BLD_KEY (공공데이터포털 서비스키 - decode 된 원문 그대로)

export default async function handler(req, res) {
  try {
    const BUILD = "2025-12-27-HO-FIX-01";

    const address = String(req.query.address || "").trim();
    const floorInput = String(req.query.floor || "").trim(); // optional
    const hoInput = String(req.query.ho || "").trim();       // optional

    if (!address) {
      return res.status(400).json({ ok: false, build: BUILD, message: "address is required" });
    }
    if (!process.env.BLD_KEY) {
      return res.status(500).json({ ok: false, build: BUILD, message: "Missing env BLD_KEY" });
    }

    // 1) 주소 → 지번키(sigunguCd, bjdongCd, bun, ji)
    const j = await geocodeJibunFromRoadAddress(address);
    if (!j?.admCd) {
      return res.status(404).json({ ok: false, build: BUILD, message: "주소를 지번키로 변환하지 못했습니다.", input: { address } });
    }

    const sigunguCd = j.admCd.slice(0, 5);
    const bjdongCd = j.admCd.slice(5, 10);
    const bun = String(j.lnbrMnnm).padStart(4, "0");
    const ji = String(j.lnbrSlno).padStart(4, "0");
    const baseKeys = { sigunguCd, bjdongCd, bun, ji };

    // 2) 층별현황(여러 item) 조회 → 층 목록은 flrNo unique로 생성
    const flrItemsAll = await fetchBldHubItems("getBrFlrOulnInfo", {
      ...baseKeys,
      numOfRows: "9999",
      pageNo: "1",
    });

    const flrNos = uniqueSortedFloors(flrItemsAll.map(it => it.flrNo));
    // floor가 없으면: "층 목록"만 내려주는 게 아니라, 기본 요약도 같이 내려줌
    // (프론트에서 층 버튼 만들기 위해)
    if (!floorInput) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "init(floor-list)",
        input: { address },
        road: j.roadAddr,
        jibun: j.jibunAddr,
        keys: baseKeys,
        floors: flrNos,
        note: "floors는 getBrFlrOulnInfo의 flrNo를 unique로 만든 실제 층 목록입니다.",
      });
    }

    const floor = normalizeFloor(floorInput);
    if (!floor) {
      return res.status(400).json({ ok: false, build: BUILD, message: "floor is invalid", input: { floor: floorInput } });
    }

    const floorItems = flrItemsAll.filter(it => normalizeFloor(it.flrNo) === floor);

    // 대표 item pick(업무/사무소 우선, 그 다음 면적 큰 것)
    const floorPick = pickBestFloorItem(floorItems);

    // 3) 해당 층 호 목록(드롭다운용) : getBrExposInfo에서 floor만 필터
    //    (전유부 목록에서 실제 hoNm을 받아, 그 값을 그대로 드롭다운에 보여주면 안전)
    const exposItemsAll = await fetchBldHubItems("getBrExposInfo", {
      ...baseKeys,
      numOfRows: "9999",
      pageNo: "1",
    });

    const hoList = uniqueHoList(
      exposItemsAll
        .filter(it => normalizeFloor(it.flrNo) === floor)
        .map(it => it.hoNm)
        .filter(Boolean)
    );

    // 4) 호 입력이 없으면: 층 item 표 + ho list 반환
    if (!hoInput) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floor-items+hoList",
        input: { address, floor },
        road: j.roadAddr,
        jibun: j.jibunAddr,
        keys: baseKeys,
        floors: flrNos,
        floor_items: floorItems,
        floor_pick: floorPick,
        ho_list: hoList,
        note: "floor_items는 같은 층 item 여러개가 올 수 있어 표로 모두 표시하는 게 정상입니다.",
      });
    }

    // 5) 호별 면적 조회
    //    5-A) exposInfo에서 area가 있으면 그걸 우선 사용
    const wantHoNorm = normalizeHo(hoInput);
    let target = exposItemsAll.find(it =>
      normalizeFloor(it.flrNo) === floor &&
      normalizeHo(it.hoNm) === wantHoNorm
    );

    let areaM2 = target ? toNumber(target.area) : 0;
    if (areaM2 > 0) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "exposInfo ho-area",
        input: { address, floor, ho: hoInput },
        road: j.roadAddr,
        jibun: j.jibunAddr,
        keys: baseKeys,
        floors: flrNos,
        ho_matched: { hoNm: target.hoNm, flrNo: target.flrNo, dongNm: target.dongNm || "" },
        area_m2: areaM2,
        area_pyeong: round2(areaM2 / 3.305785),
      });
    }

    //    5-B) exposPubuseAreaInfo로 호 지정 조회(hoNm 파라미터 사용 가능)  :contentReference[oaicite:4]{index=4}
    //         - “전유(exposPubuseGbCd=1)”만 골라서 면적(area) 추출
    //         - hoNm은 드롭다운 값 그대로 넣는 게 제일 안전
    const hoForQuery = (target?.hoNm || "").trim() || hoInput.trim();

    const pubItems = await fetchBldHubItems("getBrExposPubuseAreaInfo", {
      ...baseKeys,
      hoNm: hoForQuery,      // ✅ 문서상 지원
      numOfRows: "9999",
      pageNo: "1",
    });

    const pubTarget = pubItems.find(it =>
      normalizeFloor(it.flrNo) === floor &&
      normalizeHo(it.hoNm) === wantHoNorm &&
      (String(it.exposPubuseGbCd || "") === "1" || String(it.exposPubuseGbCdNm || "").includes("전유"))
    );

    areaM2 = pubTarget ? toNumber(pubTarget.area) : 0;
    if (areaM2 > 0) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "exposPubuseArea ho-area",
        input: { address, floor, ho: hoInput },
        road: j.roadAddr,
        jibun: j.jibunAddr,
        keys: baseKeys,
        floors: flrNos,
        ho_matched: { hoNm: pubTarget.hoNm, flrNo: pubTarget.flrNo, dongNm: pubTarget.dongNm || "" },
        area_m2: areaM2,
        area_pyeong: round2(areaM2 / 3.305785),
      });
    }

    // 6) 그래도 못 찾으면 디버그: 그 층에서 실제로 존재하는 hoNm 샘플 제공
    const hoNmSamples = exposItemsAll
      .filter(it => normalizeFloor(it.flrNo) === floor)
      .slice(0, 80)
      .map(it => it.hoNm)
      .filter(Boolean);

    return res.status(404).json({
      ok: false,
      build: BUILD,
      message: "해당 층/호 전유면적을 찾지 못했습니다. (hoNm 표기 형식/존재 여부 확인 필요)",
      input: { address, floor, ho: hoInput },
      wantHoNorm,
      hoNmSamples,
      note: "드롭다운에서 실제 hoNm(예: '802호', '802-1호')를 선택해서 조회하면 성공률이 가장 높습니다.",
    });

  } catch (e) {
    return res.status(500).json({ ok: false, build: "2025-12-27-HO-FIX-01", message: e.message });
  }
}

/* ---------------- Helpers ---------------- */

// 주소 → admCd 추출용 (간단 버전)
// 이미 쓰시던 geocode 로직이 있다면 그걸 그대로 쓰셔도 됩니다.
async function geocodeJibunFromRoadAddress(address) {
  // ⚠️ 여기 부분은 “기존에 쓰시던 주소→지번키 변환 로직”을 그대로 유지하는 게 좋아요.
  // 지금 pasted.txt에 있던 로직/엔드포인트가 이미 잘 되므로,
  // 아래는 placeholder로 두고, 기존 함수를 붙여넣어 주세요.
  // (당장 테스트용으로는 기존 코드를 그대로 가져오셔야 합니다.)
  throw new Error("geocodeJibunFromRoadAddress()를 기존 코드로 교체해 주세요. (현재는 placeholder)");
}

// 공공데이터 BldRgstHubService 호출 → XML items 파싱
async function fetchBldHubItems(op, params) {
  const url = new URL(`https://apis.data.go.kr/1613000/BldRgstHubService/${op}`);
  url.searchParams.set("serviceKey", process.env.BLD_KEY);

  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || String(v).trim() === "") continue;
    url.searchParams.set(k, String(v));
  }

  const xml = await (await fetch(url.toString())).text();
  assertApiOk(xml, op);
  return parseItems(xml).map(itemXmlToObj);
}

function assertApiOk(xml, opName) {
  const code = getTag(xml, "resultCode");
  const msg = getTag(xml, "resultMsg");
  if (code && code !== "00") {
    throw new Error(`${opName} API error: ${code} / ${msg}`);
  }
}

function parseItems(xmlText) {
  return [...xmlText.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}

function getTag(xmlTextOrChunk, tag) {
  const m = String(xmlTextOrChunk).match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}

// 필요한 태그들 넉넉히
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
  // "1209호", "1209", "1209-1" => "1209"
  const m = String(s || "").match(/\d+/);
  return m ? m[0] : "";
}

function normalizeFloor(s) {
  // "8층", "08", "8" => 8
  const m = String(s || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

function uniqueSortedFloors(flrNos) {
  const nums = flrNos
    .map(normalizeFloor)
    .filter(n => n > 0);
  const uniq = [...new Set(nums)];
  uniq.sort((a, b) => a - b);
  return uniq;
}

function uniqueHoList(hoNms) {
  // 실제 표기(802호/802-1호)를 유지하되, 정렬은 숫자 기준으로
  const uniq = [...new Set(hoNms.map(s => String(s).trim()).filter(Boolean))];
  uniq.sort((a, b) => {
    const na = parseInt(normalizeHo(a) || "0", 10);
    const nb = parseInt(normalizeHo(b) || "0", 10);
    if (na !== nb) return na - nb;
    return a.localeCompare(b);
  });
  return uniq;
}

function pickBestFloorItem(items) {
  if (!items || !items.length) return null;

  const score = (it) => {
    const area = toNumber(it.area);
    const txt = `${it.mainPurpsCdNm || ""} ${it.etcPurps || ""}`.trim();

    // 기본은 면적 큰 것
    let s = area;

    // "공용/공유"는 감점
    if (/공용|공유/.test(txt)) s -= 1_000_000;

    // "업무/사무소"는 가점
    if (/업무|사무소/.test(txt)) s += 2_000_000;

    // 그래도 애매하면 면적
    return s;
  };

  return items
    .slice()
    .sort((a, b) => score(b) - score(a))[0];
}
