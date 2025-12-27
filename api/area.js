// /api/area.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD = "2025-12-27-HO-02";

  const address = (req.query.address || "").trim();
  const floor = String(req.query.floor || "").trim(); // 예: "12"
  const hoInput = (req.query.ho || "").trim();        // 예: "1209" 또는 "1209호"

  if (!address || !floor) {
    return res.status(400).json({ ok: false, build: BUILD, message: "address와 floor는 필수입니다." });
  }

  try {
    // 0) 입력 정규화
    const wantHo = hoInput
      ? (hoInput.endsWith("호") ? hoInput : `${hoInput}호`)
      : null;

    // ✅ 핵심: 호는 숫자만 비교 (표기 차이 대응)
    const wantHoNum = hoInput ? String(hoInput).replace(/\D/g, "") : null; // "1209"

    // 1) JUSO: 도로명주소 -> 지번코드(시군구/법정동/번/지)
    const juso = await fetchJuso(address);

    const sigunguCd = juso.sigunguCd;
    const bjdongCd = juso.bjdongCd;
    const bun = juso.bun;
    const ji = juso.ji;

    const baseKeys = { sigunguCd, bjdongCd, bun, ji };

    // 2) (호별 우선) 전유부 목록(getBrExposInfo)에서 "층/호"를 찾아 mgmBldrgstPk 확보
    let exposTarget = null;
    let exposMeta = null;

    if (wantHo) {
      const expos = await fetchExposInfoTryPlatGb(baseKeys);
      exposMeta = expos.meta;

      // ✅ 호(hoNm) 형식이 "1209호" / "1209" / "1209-1" 등 다양해서 숫자만 비교
      exposTarget = expos.items.find(it => {
        const flrNo = String(getTag(it, "flrNo") || "").trim();
        const hoNm = String(getTag(it, "hoNm") || "").trim();
        const hoNum = hoNm.replace(/\D/g, ""); // 숫자만

        if (flrNo !== String(floor)) return false;
        if (wantHoNum && hoNum !== wantHoNum) return false;

        return true;
      });

      // ✅ 호 매칭 실패하면, hoNm이 어떻게 오는지 바로 확인 가능하도록 디버그 반환
      if (!exposTarget) {
        const preview = expos.items.slice(0, 40).map(it => ({
          flrNo: getTag(it, "flrNo"),
          hoNm: getTag(it, "hoNm"),
          mgmBldrgstPk: getTag(it, "mgmBldrgstPk"),
        }));

        return res.status(200).json({
          ok: false,
          build: BUILD,
          message: "전유부 목록(getBrExposInfo)에서 해당 층/호를 못 찾았습니다. (hoNm 표기 형식 확인 필요)",
          input: { address, floor, ho: hoInput || null, wantHo, wantHoNum },
          keys: baseKeys,
          exposMeta,
          exposPreview: preview,
          note: "exposPreview에서 실제 hoNm 값(예: 1209, 1209호, 1209-1 등)을 확인 후 매칭 로직을 더 맞춥니다."
        });
      }

      // ✅ exposInfo에 전유면적이 직접 들어있는 케이스가 있어서 먼저 시도
      const directArea = pickNumberByTags(exposTarget, [
        "excluUseAr", "excluAr", "area", "totArea", "totAr"
      ]);
      if (directArea > 0) {
        return res.status(200).json({
          ok: true,
          build: BUILD,
          mode: "exposInfo direct (호별 전유면적)",
          input: { address, floor, ho: hoInput || null },
          jibun: juso.jibunAddr,
          road: juso.roadAddr,
          keys: baseKeys,
          matched: { flrNo: getTag(exposTarget, "flrNo"), hoNm: getTag(exposTarget, "hoNm") },
          area_m2: round2(directArea),
          area_pyeong: round2(toPyeong(directArea)),
          note: "전유부(getBrExposInfo) 응답에 전유면적 태그가 포함되어 직접 사용했습니다."
        });
      }

      // 3) (호별) PK로 전유/공유면적(getBrExposPubuseAreaInfo) 호출 -> 전유면적 추출
      const mgmBldrgstPk = getTag(exposTarget, "mgmBldrgstPk") || "";

      if (!mgmBldrgstPk) {
        // 호별 PK가 없으면 층별 fallback
        const flr = await fetchFlrOuln(baseKeys, floor);
        return res.status(200).json({
          ok: true,
          build: BUILD,
          mode: "flrOuln fallback (층 면적) - 호 PK 없음",
          input: { address, floor, ho: hoInput || null },
          jibun: juso.jibunAddr,
          road: juso.roadAddr,
          keys: baseKeys,
          area_m2: round2(flr.areaM2),
          area_pyeong: round2(toPyeong(flr.areaM2)),
          note: "전유부 PK(mgmBldrgstPk)가 없어 호별 전유면적 조회가 불가하여 층면적으로 대체했습니다."
        });
      }

      const pubuse = await fetchExposPubuseArea({ ...baseKeys, mgmBldrgstPk });

      // ✅ '전유' 행 우선
      const jeonyuItem =
        pubuse.items.find(it => {
          const s = getTag(it, "exposSeCdNm") || getTag(it, "exposSeNm") || getTag(it, "seNm");
          return (s || "").includes("전유");
        }) || pubuse.items[0];

      if (!jeonyuItem) {
        // pubuse 응답 자체에 item이 없으면 디버그
        return res.status(500).json({
          ok: false,
          build: BUILD,
          message: "getBrExposPubuseAreaInfo 응답에 item이 없습니다.",
          input: { address, floor, ho: hoInput || null },
          keys: baseKeys,
          mgmBldrgstPk,
          pubuseMeta: pubuse.meta
        });
      }

      const areaM2 = pickNumberByTags(jeonyuItem, [
        "excluUseAr", "excluAr", "area", "totArea", "totAr"
      ]);

      if (areaM2 > 0) {
        return res.status(200).json({
          ok: true,
          build: BUILD,
          mode: "exposPubuseArea (호별 전유면적)",
          input: { address, floor, ho: hoInput || null },
          jibun: juso.jibunAddr,
          road: juso.roadAddr,
          keys: baseKeys,
          matched: { flrNo: getTag(exposTarget, "flrNo"), hoNm: getTag(exposTarget, "hoNm") },
          mgmBldrgstPk,
          area_m2: round2(areaM2),
          area_pyeong: round2(toPyeong(areaM2)),
          note: "호별 전유면적을 전유/공유면적(getBrExposPubuseAreaInfo)에서 추출했습니다."
        });
      }

      // 면적 태그가 다르면 여기로 떨어짐 -> 디버그
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "호별 데이터는 찾았지만(전유/공유), 면적 태그를 못 찾았습니다. 태그명이 다른 케이스입니다.",
        input: { address, floor, ho: hoInput || null },
        keys: baseKeys,
        mgmBldrgstPk,
        pubuseMeta: pubuse.meta,
        debug: {
          candidates: ["excluUseAr", "excluAr", "area", "totArea", "totAr"],
          firstItemHead: pubuse.items[0]?.slice(0, 900) || ""
        }
      });
    }

    // 4) (층별 fallback) ho가 없으면 층별 면적 반환
    const flr = await fetchFlrOuln(baseKeys, floor);
    return res.status(200).json({
      ok: true,
      build: BUILD,
      mode: "flrOuln (층 면적)",
      input: { address, floor, ho: hoInput || null },
      jibun: juso.jibunAddr,
      road: juso.roadAddr,
      keys: baseKeys,
      area_m2: round2(flr.areaM2),
      area_pyeong: round2(toPyeong(flr.areaM2)),
      note: "층별 면적을 반환했습니다."
    });

  } catch (e) {
    return res.status(500).json({ ok: false, build: "ERR", message: e.message });
  }
}

/* ---------------- helpers ---------------- */

async function fetchJuso(address) {
  const jusoUrl = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
  jusoUrl.searchParams.set("confmKey", process.env.JUSO_KEY);
  jusoUrl.searchParams.set("currentPage", "1");
  jusoUrl.searchParams.set("countPerPage", "10");
  jusoUrl.searchParams.set("keyword", address);
  jusoUrl.searchParams.set("resultType", "json");

  const jusoRes = await fetch(jusoUrl.toString());
  const jusoData = await jusoRes.json();
  const jusoList = jusoData?.results?.juso || [];
  if (!jusoList.length) throw new Error("주소 검색 결과가 없습니다(JUSO).");

  const j = jusoList[0];
  const admCd = j.admCd;

  const sigunguCd = admCd.slice(0, 5);
  const bjdongCd = admCd.slice(5, 10);
  const bun = String(j.lnbrMnnm).padStart(4, "0");
  const ji = String(j.lnbrSlno).padStart(4, "0");

  return {
    sigunguCd, bjdongCd, bun, ji,
    jibunAddr: j.jibunAddr || "",
    roadAddr: j.roadAddr || ""
  };
}

// serviceKey 인코딩/디코딩 이슈 대응
function addServiceKey(urlObj, key) {
  const keyStr = String(key || "").trim();
  if (!keyStr) return urlObj;

  const looksEncoded = /%[0-9A-Fa-f]{2}/.test(keyStr);
  if (!looksEncoded) {
    urlObj.searchParams.set("serviceKey", keyStr);
    return urlObj;
  }
  const base = urlObj.toString();
  const sep = base.includes("?") ? "&" : "?";
  return new URL(base + sep + "serviceKey=" + keyStr);
}

async function fetchXml(urlObj) {
  const res = await fetch(urlObj.toString());
  const xml = await res.text();
  return { res, xml };
}

function parseMeta(xml) {
  const totalCount = xml.match(/<totalCount>(\d+)<\/totalCount>/)?.[1] || "";
  const resultCode = xml.match(/<resultCode>(.*?)<\/resultCode>/)?.[1]?.trim() || "";
  const resultMsg = xml.match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1]?.trim() || "";
  return { totalCount, resultCode, resultMsg };
}

function parseItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}

function getTag(xmlChunk, tag) {
  const m = xmlChunk.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}

function pickNumberByTags(itemXml, candidates) {
  for (const t of candidates) {
    const v = getTag(itemXml, t);
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function toPyeong(m2) {
  return Number(m2) / 3.305785;
}

function round2(n) {
  return Number(Number(n).toFixed(2));
}

/* ------------ 건축HUB 호출들 ------------ */

// 전유부 목록: getBrExposInfo
async function fetchExposInfoTryPlatGb(keys) {
  const tried = [];

  for (const platGbCd of ["0", "1"]) {
    const u0 = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposInfo");
    const u = addServiceKey(u0, process.env.BLD_KEY);

    u.searchParams.set("sigunguCd", keys.sigunguCd);
    u.searchParams.set("bjdongCd", keys.bjdongCd);
    u.searchParams.set("bun", keys.bun);
    u.searchParams.set("ji", keys.ji);
    u.searchParams.set("platGbCd", platGbCd);
    u.searchParams.set("numOfRows", "5000");
    u.searchParams.set("pageNo", "1");

    const { xml } = await fetchXml(u);
    const meta = parseMeta(xml);
    const items = parseItems(xml);

    tried.push({ platGbCd, itemsCount: items.length, meta });

    if (items.length) {
      return { items, meta: { ...meta, tried } };
    }
  }

  return { items: [], meta: { tried } };
}

// 전유/공유 면적: getBrExposPubuseAreaInfo
async function fetchExposPubuseArea(params) {
  const u0 = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo");
  const u = addServiceKey(u0, process.env.BLD_KEY);

  u.searchParams.set("sigunguCd", params.sigunguCd);
  u.searchParams.set("bjdongCd", params.bjdongCd);
  u.searchParams.set("bun", params.bun);
  u.searchParams.set("ji", params.ji);
  u.searchParams.set("mgmBldrgstPk", params.mgmBldrgstPk);
  u.searchParams.set("numOfRows", "100");
  u.searchParams.set("pageNo", "1");

  const { xml } = await fetchXml(u);
  const meta = parseMeta(xml);
  const items = parseItems(xml);
  return { items, meta };
}

// 층별 개요: getBrFlrOulnInfo (fallback/층면적)
async function fetchFlrOuln(keys, floor) {
  const u0 = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrFlrOulnInfo");
  const u = addServiceKey(u0, process.env.BLD_KEY);

  u.searchParams.set("sigunguCd", keys.sigunguCd);
  u.searchParams.set("bjdongCd", keys.bjdongCd);
  u.searchParams.set("bun", keys.bun);
  u.searchParams.set("ji", keys.ji);
  u.searchParams.set("numOfRows", "5000");
  u.searchParams.set("pageNo", "1");

  const { xml } = await fetchXml(u);
  const items = parseItems(xml);
  if (!items.length) throw new Error("층별(getBrFlrOulnInfo) 데이터가 없습니다.");

  const target = items.find(it => String(getTag(it, "flrNo")) === String(floor));
  if (!target) throw new Error("요청한 층(flrNo)에 해당하는 층별 데이터가 없습니다.");

  const areaM2 = pickNumberByTags(target, ["area", "flrArea", "totArea", "totAr"]);
  if (!areaM2) throw new Error("층별 면적 태그를 찾지 못했습니다(getBrFlrOulnInfo).");

  return { areaM2 };
}
