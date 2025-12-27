// /pages/api/area.js  (Next.js / Vercel)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD = "2025-12-27-FINAL";

  const address = (req.query.address || "").trim();
  const floor = String(req.query.floor || "").trim(); // 층 필수
  const hoInput = (req.query.ho || "").trim();        // 선택

  if (!address || !floor) {
    return res.status(400).json({ ok: false, build: BUILD, message: "address와 floor는 필수입니다." });
  }

  try {
    /* ------------------------------------------------------------
     * 1) JUSO 주소 → 지번(행정코드)
     * ------------------------------------------------------------ */
    const jusoUrl = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
    jusoUrl.searchParams.set("confmKey", process.env.JUSO_KEY);
    jusoUrl.searchParams.set("currentPage", "1");
    jusoUrl.searchParams.set("countPerPage", "10");
    jusoUrl.searchParams.set("keyword", address);
    jusoUrl.searchParams.set("resultType", "json");

    const jusoRes = await fetch(jusoUrl.toString());
    const jusoData = await jusoRes.json();
    const jusoList = jusoData?.results?.juso || [];
    if (!jusoList.length) throw new Error("주소 검색 결과가 없습니다.");

    const j = jusoList[0];
    const admCd = j.admCd;

    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd = admCd.slice(5, 10);
    const bun = String(j.lnbrMnnm).padStart(4, "0");
    const ji = String(j.lnbrSlno).padStart(4, "0");

    const baseKeys = { sigunguCd, bjdongCd, bun, ji };

    /* ------------------------------------------------------------
     * 2) 층별현황 (getBrFlrOulnInfo)
     * ------------------------------------------------------------ */
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
    const floorItems = flrItems.filter(it => String(it.flrNo || "") === String(floor));
    const pick = pickBestFloorItem(floorItems);

    /* ------------------------------------------------------------
     * 3) 층만 조회 → ho_list 같이 반환
     * ------------------------------------------------------------ */
    if (!hoInput) {
      let hoList = [];
      let hoNote = "";

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

        const rawHos = exposItems
          .filter(it => String(it.flrNo || "") === String(floor))
          .map(it => (it.hoNm || "").trim())
          .filter(Boolean);

        const uniq = [...new Set(rawHos)];
        hoList = uniq.sort((a, b) => {
          const na = normalizeHo(a);
          const nb = normalizeHo(b);
          if (na !== nb) return na.localeCompare(nb, "en", { numeric: true });
          return a.localeCompare(b, "ko");
        });

        if (!hoList.length) hoNote = "해당 층에서 호 목록을 찾지 못했습니다.";
      } catch (e) {
        hoNote = `호 목록 조회 실패: ${e.message}`;
      }

      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "floorItems+hoList",
        input: { address, floor, ho: null },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        floor_items: floorItems.map(toClientFloorItem),
        pick: pick ? toClientFloorItem(pick) : null,
        ho_list: hoList,
        ho_list_note: hoNote,
      });
    }

    /* ------------------------------------------------------------
     * 4) 호별 면적 (1차: 전유부 getBrExposInfo)
     * ------------------------------------------------------------ */
    const wantHoNorm = normalizeHo(hoInput);

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
      String(it.flrNo || "") === String(floor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm
    );

    let areaM2 = target ? toNumber(target.area) : 0;

    if (areaM2 > 0) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "exposInfo(전유부)",
        input: { address, floor, ho: hoInput },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        ho_matched: { hoNm: target.hoNm, flrNo: target.flrNo },
        area_m2: areaM2,
        area_pyeong: round2(areaM2 / 3.305785),
      });
    }

    /* ------------------------------------------------------------
     * 5) 호별 면적 (2차: 전유/공용 getBrExposPubuseAreaInfo)
     * ------------------------------------------------------------ */
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

    target = pubItems.find(it =>
      String(it.flrNo || "") === String(floor) &&
      normalizeHo(it.hoNm || "") === wantHoNorm &&
      (String(it.exposPubuseGbCd || "") === "1" || (it.exposPubuseGbCdNm || "").includes("전유"))
    );

    areaM2 = target ? toNumber(target.area) : 0;

    if (areaM2 > 0) {
      return res.status(200).json({
        ok: true,
        build: BUILD,
        mode: "exposPubuseArea(전유)",
        input: { address, floor, ho: hoInput },
        jibun: j.jibunAddr,
        road: j.roadAddr,
        keys: baseKeys,
        ho_matched: { hoNm: target.hoNm, flrNo: target.flrNo },
        area_m2: areaM2,
        area_pyeong: round2(areaM2 / 3.305785),
      });
    }

    /* ------------------------------------------------------------
     * 6) 실패 시 안내
     * ------------------------------------------------------------ */
    const hoSamples = pubItems
      .filter(it => String(it.flrNo || "") === String(floor))
      .slice(0, 30)
      .map(it => it.hoNm)
      .filter(Boolean);

    return res.status(404).json({
      ok: false,
      build: BUILD,
      message: "해당 층/호의 전유면적을 찾지 못했습니다.",
      input: { address, floor, ho: hoInput },
      wantHoNorm,
      hoNmSamples: hoSamples,
      note: "공공데이터에 전유면적이 없는 호일 수 있습니다.",
    });

  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message, build: BUILD });
  }
}

/* ================= helpers ================= */

function getTag(xmlChunk, tag) {
  const m = xmlChunk.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}

function parseItems(xmlText) {
  return [...xmlText.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}

function itemXmlToObj(item) {
  const tags = [
    "flrNo", "flrNoNm", "flrGbCdNm",
    "hoNm", "dongNm",
    "exposPubuseGbCd", "exposPubuseGbCdNm",
    "mainPurpsCdNm", "etcPurps",
    "area"
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
  // "1209호" → "1209", "1209-1호" → "1209-1"
  const t = String(s || "").replace(/\s+/g, "").replace(/호$/g, "");
  const m = t.match(/^\d+(?:-\d+)?/);
  return m ? m[0] : "";
}

function pickBestFloorItem(items) {
  if (!items || !items.length) return null;
  const score = (it) => {
    let s = toNumber(it.area);
    const txt = `${it.mainPurpsCdNm || ""} ${it.etcPurps || ""}`;
    if (txt.includes("공용")) s -= 100000;
    if (txt.includes("업무") || txt.includes("사무")) s += 50000;
    return s;
  };
  return [...items].sort((a, b) => score(b) - score(a))[0];
}

function toClientFloorItem(it) {
  const areaM2 = toNumber(it.area);
  return {
    flrNo: it.flrNo || "",
    flrGbCdNm: it.flrGbCdNm || "",
    mainPurpsCdNm: it.mainPurpsCdNm || "",
    etcPurps: it.etcPurps || "",
    area_m2: areaM2,
    area_pyeong: round2(areaM2 / 3.305785),
  };
}

function assertApiOk(xmlText, apiName) {
  const resultCode = xmlText.match(/<resultCode>(.*?)<\/resultCode>/)?.[1]?.trim() || "";
  const resultMsg  = xmlText.match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1]?.trim() || "";
  if (resultCode && resultCode !== "00") {
    throw new Error(`${apiName} 실패: ${resultCode} ${resultMsg}`);
  }
  if ((xmlText || "").includes("API not found")) {
    throw new Error(`${apiName} 실패: API not found (엔드포인트 확인 필요)`);
  }
}
