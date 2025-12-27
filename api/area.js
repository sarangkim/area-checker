// /pages/api/floors.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD = "2025-12-27-FLOORS-01";
  const address = (req.query.address || "").trim();
  if (!address) return res.status(400).json({ ok: false, build: BUILD, message: "address는 필수입니다." });

  try {
    // 1) 주소→지번키
    const jusoUrl = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
    jusoUrl.searchParams.set("confmKey", process.env.JUSO_KEY);
    jusoUrl.searchParams.set("currentPage", "1");
    jusoUrl.searchParams.set("countPerPage", "10");
    jusoUrl.searchParams.set("keyword", address);
    jusoUrl.searchParams.set("resultType", "json");

    const jusoData = await (await fetch(jusoUrl.toString())).json();
    const jusoList = jusoData?.results?.juso || [];
    if (!jusoList.length) throw new Error("주소 검색 결과가 없습니다.");

    const j = jusoList[0];
    const admCd = j.admCd;

    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd = admCd.slice(5, 10);
    const bun = String(j.lnbrMnnm).padStart(4, "0");
    const ji = String(j.lnbrSlno).padStart(4, "0");

    // 2) 층별현황 전체 가져와서 flrNo 리스트 뽑기
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

    // 지상만(보통 flrGbCdNm = "지상") + 숫자층만
    const floors = Array.from(
      new Set(
        flrItems
          .filter(it => (it.flrGbCdNm || "").includes("지상"))
          .map(it => Number(it.flrNo))
          .filter(n => Number.isFinite(n) && n > 0)
      )
    ).sort((a, b) => a - b);

    return res.status(200).json({
      ok: true,
      build: BUILD,
      input: { address },
      road: j.roadAddr,
      jibun: j.jibunAddr,
      keys: { sigunguCd, bjdongCd, bun, ji },
      floors,
      maxFloor: floors.length ? floors[floors.length - 1] : null,
      note: "층 목록은 getBrFlrOulnInfo(층별현황)에서 지상층만 추출했습니다."
    });

  } catch (e) {
    return res.status(500).json({ ok: false, build: BUILD, message: e.message });
  }
}

/* ---------- helpers (area.js와 동일하게) ---------- */
function assertApiOk(xmlText, op) {
  const code = getTag(xmlText, "resultCode");
  const msg = getTag(xmlText, "resultMsg");
  if (code && code !== "00") throw new Error(`${op} 실패: ${code} ${msg}`);
}

function getTag(xmlChunk, tag) {
  const m = xmlChunk.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}

function parseItems(xmlText) {
  return [...xmlText.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
}

function itemXmlToObj(itemXml) {
  // 필요한 것만 뽑아도 되지만, 여기선 범용으로 key-value 추출
  const obj = {};
  const tags = [...itemXml.matchAll(/<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g)];
  for (const t of tags) obj[t[1]] = (t[2] || "").trim();
  return obj;
}
