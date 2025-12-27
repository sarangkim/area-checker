// api/area.js
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD = "2025-12-27-B-01";

  const address = (req.query.address || "").trim(); // 도로명/지번
  const floor = String(req.query.floor || "").trim(); // 예: 3
  const hoInput = (req.query.ho || "").trim(); // 예: 501 or 501호 (선택)

  if (!address || !floor) {
    return res.status(400).json({ ok: false, message: "address와 floor는 필수입니다." });
  }

  try {
    // =========================
    // 1) JUSO 검색: 주소 → 지번코드(sigungu/bjdong/bun/ji)
    // =========================
    const juso = await jusoSearch(address);

    const sigunguCd = juso.sigunguCd;
    const bjdongCd = juso.bjdongCd;
    const bun = juso.bun;
    const ji = juso.ji;

    const wantHo = hoInput ? (hoInput.endsWith("호") ? hoInput : `${hoInput}호`) : null;

    // =========================
    // 2) 1차 시도: 전유부 목록(getBrExposInfo) → (층/호 매칭) → mgmBldrgstPk 확보
    // =========================
    const exposListXml = await callBldHub("getBrExposInfo", {
      sigunguCd, bjdongCd, bun, ji,
      numOfRows: "5000",
      pageNo: "1",
    });

    const exposItems = extractItems(exposListXml);
    if (exposItems.length) {
      const picked = exposItems.find(it => {
        const flrNo = getTag(it, "flrNo"); // 층
        const hoNm = getTag(it, "hoNm");   // 호
        if (String(flrNo) !== String(floor)) return false;
        if (wantHo && hoNm !== wantHo) return false;
        return true;
      });

      if (picked) {
        const mgmBldrgstPk = getTag(picked, "mgmBldrgstPk");

        // =========================
        // 3) 2차 시도: 전유공용면적(getBrExposPubuseAreaInfo) 호출
        //    - 앱의 "전유/공유 현황"에 해당할 확률이 가장 큼
        //    - 문서마다 파라미터가 다를 수 있어, 가능한 키들은 최대한 넣어봄
        // =========================
        if (mgmBldrgstPk) {
          const pubuseXml = await callBldHub("getBrExposPubuseAreaInfo", {
            sigunguCd, bjdongCd, bun, ji,
            mgmBldrgstPk, // ⭐ 핵심(전유부 PK)
            numOfRows: "100",
            pageNo: "1",
          });

          const pubuseItem = extractFirstItem(pubuseXml);
          if (pubuseItem) {
            // 전유면적/공용면적 후보 태그들 (문서마다 조금씩 다를 수 있음)
            const excluM2 = pickNumber(pubuseItem, [
              "excluUseAr", "excluUseArea", "excluAr", "prvuseArea", "prvUseAr"
            ]);
            const pubuseM2 = pickNumber(pubuseItem, [
              "pubuseAr", "pubuseArea", "commUseAr", "commUseArea"
            ]);

            // 1) 전유면적이 잡히면 그걸 “호별(또는 해당 단위) 전유면적”로 채택
            if (excluM2 > 0) {
              return res.status(200).json({
                ok: true,
                build: BUILD,
                mode: "exposPubuseArea (호/단위 우선)",
                input: { address, floor, ho: hoInput || null },
                jibun: juso.jibunAddr,
                road: juso.roadAddr,
                keys: { sigunguCd, bjdongCd, bun, ji, mgmBldrgstPk },
                area_m2: excluM2,
                area_pyeong: toPyeong(excluM2),
                // 참고: 공용면적도 잡히면 같이 내려줌
                shared_m2: pubuseM2 > 0 ? pubuseM2 : null,
                shared_pyeong: pubuseM2 > 0 ? toPyeong(pubuseM2) : null,
              });
            }

            // 2) 전유면적이 없고 공용만 있거나, 태그명이 다르면 디버그 제공 후 층별로 폴백
          }
        }
      }
    }

    // =========================
    // 4) 폴백: 층별개요(getBrFlrOulnInfo)로 “해당 층 면적” 찾기
    // =========================
    const flrXml = await callBldHub("getBrFlrOulnInfo", {
      sigunguCd, bjdongCd, bun, ji,
      numOfRows: "5000",
      pageNo: "1",
    });

    const flrItems = extractItems(flrXml);
    if (!flrItems.length) {
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "층별개요(getBrFlrOulnInfo) item이 없습니다.",
        debug: debugHead(flrXml),
      });
    }

    // 층 매칭: flrNo / flrNm / flrGbCdNm 등 케이스별로 대비
    const floorItem = flrItems.find(it => {
      const flrNo = getTag(it, "flrNo");
      const flrNm = getTag(it, "flrNm"); // 어떤 데이터는 "3층" 같은 텍스트
      if (flrNo && String(flrNo) === String(floor)) return true;
      if (flrNm && String(flrNm).includes(String(floor))) return true;
      return false;
    });

    if (!floorItem) {
      return res.status(404).json({
        ok: false,
        build: BUILD,
        message: "층별개요에서 해당 층을 찾지 못했습니다. (floor 확인)",
        sample: flrItems.slice(0, 10).map(it => ({
          flrNo: getTag(it, "flrNo"),
          flrNm: getTag(it, "flrNm"),
          use: getTag(it, "mainPurpsCdNm") || getTag(it, "etcPurps") || "",
        })),
      });
    }

    // 층 면적 태그 후보들 (문서/데이터마다 다름)
    const flrAreaM2 = pickNumber(floorItem, [
      "area", "flrArea", "totArea", "useAr", "useArea",
      "excluUseAr", "excluUseArea", // 혹시 층에 전유가 들어오는 케이스
    ]);

    if (!(flrAreaM2 > 0)) {
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "층별개요 item은 있는데 면적 태그를 찾지 못했습니다. 태그명 확인 필요",
        itemHead: floorItem.slice(0, 1200),
      });
    }

    return res.status(200).json({
      ok: true,
      build: BUILD,
      mode: "flrOuln fallback (층 면적)",
      input: { address, floor, ho: hoInput || null },
      jibun: juso.jibunAddr,
      road: juso.roadAddr,
      keys: { sigunguCd, bjdongCd, bun, ji },
      area_m2: flrAreaM2,
      area_pyeong: toPyeong(flrAreaM2),
      note: "호별 전유면적이 공개 API에서 미제공/미등재인 경우, 층별 면적으로 대체합니다.",
    });

  } catch (e) {
    return res.status(500).json({ ok: false, build: BUILD, message: e.message });
  }
}

/* =========================
   JUSO: 주소검색
========================= */
async function jusoSearch(keyword) {
  const url = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
  url.searchParams.set("confmKey", process.env.JUSO_KEY);
  url.searchParams.set("currentPage", "1");
  url.searchParams.set("countPerPage", "10");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("resultType", "json");

  const r = await fetch(url.toString());
  const data = await r.json();
  const list = data?.results?.juso || [];
  if (!list.length) throw new Error("주소 검색 결과가 없습니다. (JUSO)");

  const j = list[0];
  const admCd = j.admCd || "";
  if (admCd.length < 10) throw new Error("JUSO 응답 admCd가 비정상입니다.");

  const sigunguCd = admCd.slice(0, 5);
  const bjdongCd = admCd.slice(5, 10);
  const bun = String(j.lnbrMnnm).padStart(4, "0");
  const ji = String(j.lnbrSlno).padStart(4, "0");

  return {
    sigunguCd, bjdongCd, bun, ji,
    jibunAddr: j.jibunAddr,
    roadAddr: j.roadAddrPart1,
  };
}

/* =========================
   건축HUB 호출 공통
========================= */
async function callBldHub(operation, params) {
  const url = new URL(`https://apis.data.go.kr/1613000/BldRgstHubService/${operation}`);
  url.searchParams.set("serviceKey", process.env.BLD_KEY);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).length) url.searchParams.set(k, String(v));
  }

  const r = await fetch(url.toString());
  const text = await r.text();

  // “API not found” 방지: 존재하는 오퍼레이션만 쓰면 여기 걸릴 일 없음
  if (text.includes("API not found")) {
    throw new Error(`API not found: ${operation} (오퍼레이션명 확인 필요)`);
  }
  return text;
}

/* =========================
   XML 파싱 유틸
========================= */
function extractItems(xmlText) {
  return [...xmlText.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}
function extractFirstItem(xmlText) {
  return xmlText.match(/<item>([\s\S]*?)<\/item>/)?.[1] || "";
}
function getTag(xmlChunk, tag) {
  const m = xmlChunk.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}
function pickNumber(xmlChunk, tags) {
  for (const t of tags) {
    const v = getTag(xmlChunk, t);
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // area/Ar/Area 비슷한 숫자 태그 자동 스캔(최후수단)
  const candidates = [...xmlChunk.matchAll(/<([a-zA-Z0-9_]+)>([\d.]+)<\/\1>/g)]
    .map(m => ({ tag: m[1], val: Number(m[2]) }))
    .filter(x => Number.isFinite(x.val) && x.val > 0 && /ar|area|Ar|Area/.test(x.tag));

  if (candidates.length) return candidates[0].val;
  return 0;
}
function toPyeong(m2) {
  return Number((m2 / 3.305785).toFixed(2));
}
function debugHead(xmlText) {
  return { head: xmlText.slice(0, 800) };
}
