// /api/area.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD = "2025-12-27-HO-01";

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

    // 1) JUSO: 도로명주소 -> 지번코드(시군구/법정동/번/지)
    const juso = await fetchJuso(address);

    const sigunguCd = juso.sigunguCd;
    const bjdongCd = juso.bjdongCd;
    const bun = juso.bun;
    const ji = juso.ji;

    const baseKeys = { sigunguCd, bjdongCd, bun, ji };

    // 2) (호별 우선) 전유부 목록(getBrExposInfo)에서 "층/호"를 찾아 mgmBldrgstPk 확보
    let exposTarget = null;
    let exposListMeta = null;

    if (wantHo) {
      const expos = await fetchExposInfoTryPlatGb(baseKeys);
      exposListMeta = expos.meta;

      exposTarget = expos.items.find(it => {
        const flrNo = getTag(it, "flrNo");
        const hoNm = getTag(it, "hoNm");
        return String(flrNo) === String(floor) && hoNm === wantHo;
      });

      // ✅ exposInfo에 전유면적(excluUseAr)이 직접 있을 때도 있음 (바로 사용 가능)
      if (exposTarget) {
        const directArea = pickNumberByTags(exposTarget, [
          "excluUseAr", "excluAr", "area", "totArea", "totAr"
        ]);
        if (directArea > 0) {
          const areaP = toPyeong(directArea);
          return res.status(200).json({
            ok: true,
            build: BUILD,
            mode: "exposInfo direct (호별 전유면적)",
            input: { address, floor, ho: hoInput || null },
            jibun: juso.jibunAddr,
            road: juso.roadAddr,
            keys: baseKeys,
            hoNm: wantHo,
            area_m2: round2(directArea),
            area_pyeong: round2(areaP),
            note: "전유부(getBrExposInfo) 응답에 전유면적 태그가 포함되어 직접 사용했습니다."
          });
        }
      }
    }

    // 3) (호별) PK가 있으면 전유/공유면적(getBrExposPubuseAreaInfo)에서 전유면적 찾기
    if (wantHo && exposTarget) {
      const mgmBldrgstPk = getTag(exposTarget, "mgmBldrgstPk") || "";

      // PK가 없으면 호별 면적 조회가 거의 불가능
      if (!mgmBldrgstPk) {
        // 호별 실패 → 층별 fallback
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

      // ✅ '전유' 행을 우선으로 찾기
      // 응답에 구분 태그가 다양한데, 보통 exposSeCdNm / exposSeCd / seNm 같은게 있음
      const jeonyuItem = pubuse.items.find(it => {
        const s1 = getTag(it, "exposSeCdNm") || getTag(it, "exposSeNm") || getTag(it, "seNm");
        return (s1 || "").includes("전유");
      }) || pubuse.items[0]; // 전유가 명확히 없으면 첫 item이라도 시도

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
          mgmBldrgstPk,
          hoNm: wantHo,
          area_m2: round2(areaM2),
          area_pyeong: round2(toPyeong(areaM2)),
          note: "호별 전유면적을 전유/공유면적(getBrExposPubuseAreaInfo)에서 추출했습니다."
        });
      }

      // 호별 조회는 됐는데 면적 태그를 못 찾는 경우 → 디버그 노출(키 제외)
      return res.status(500).json({
        ok: false,
        build: BUILD,
        message: "호별 데이터는 찾았지만(전유/공유), 면적 태그를 찾지 못했습니다. 태그명이 다른 케이스입니다.",
        debug: {
          address, floor, wantHo,
          keys: baseKeys,
          mgmBldrgstPk,
          exposFound: true,
          exposTagsPreview: previewTags(exposTarget),
          pubuseFirstItemPreview: pubuse.items[0] ? pubuse.items[0].slice(0, 900) : "(no item)",
          totalCount: pubuse.meta.totalCount,
          resultCode: pubuse.meta.resultCode,
          resultMsg: pubuse.meta.resultMsg
        }
      });
    }

    // 4) (층별 fallback) 호 입력이 없거나, 호를 못 찾으면 층별(getBrFlrOulnInfo)
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
      note: wantHo
        ? "호별 전유면적 데이터를 공공API에서 찾지 못해 층 면적으로 대체했습니다."
        : "층별 면적을 반환했습니다."
    });

  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
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

// serviceKey 인코딩/디코딩 이슈 대응:
// - env에 "디코딩키(원본키)"를 넣는게 가장 좋음
// - 만약 env에 이미 %2F 같은게 들어간 "인코딩키"라면 searchParams.set을 쓰면 %가 %25로 재인코딩됨 -> 깨짐
// 그래서: 키가 이미 인코딩된 형태면 URL에 그대로 붙인다.
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

function previewTags(itemXml) {
  // itemXml 앞부분에서 태그명 몇 개만 뽑아보기 (디버그용)
  const tags = [...itemXml.matchAll(/<([a-zA-Z0-9_]+)>/g)].map(m => m[1]);
  const uniq = [...new Set(tags)];
  return uniq.slice(0, 40);
}

/* ------------ 건축HUB 호출들 ------------ */

// 전유부 목록: getBrExposInfo
// 어떤 지번은 platGbCd(대지/산) 영향이 있어서 0/1 둘 다 시도
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

// 전유/공유 면적: getBrExposPubuseAreaInfo (호별 전유면적용)
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

  // 층 매칭: flrNo 태그가 보통 있음
  const target = items.find(it => String(getTag(it, "flrNo")) === String(floor));
  if (!target) throw new Error("요청한 층(flrNo)에 해당하는 층별 데이터가 없습니다.");

  // 층 면적 태그 후보들
  const areaM2 = pickNumberByTags(target, ["area", "flrArea", "totArea", "totAr"]);
  if (!areaM2) throw new Error("층별 면적 태그를 찾지 못했습니다(getBrFlrOulnInfo).");

  return { areaM2 };
}
