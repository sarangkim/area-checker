// /api/floors.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD = "2025-12-27-FLOORS-FINAL";
  const address = (req.query.address || "").trim();
  if (!address) return res.status(400).json({ ok: false, message: "address는 필수입니다." });

  try {
    // 1) 주소 검색 (도로명 -> 지번/법정동코드)
    const jusoUrl = `https://business.juso.go.kr/addrlink/addrLinkApi.do?confmKey=${process.env.JUSO_KEY}&currentPage=1&countPerPage=1&keyword=${encodeURIComponent(address)}&resultType=json`;
    const jusoRes = await fetch(jusoUrl);
    const jusoData = await jusoRes.json();
    const j = jusoData?.results?.juso?.[0];

    if (!j) throw new Error("주소 검색 결과가 없습니다.");

    const sigunguCd = j.admCd.slice(0, 5);
    const bjdongCd = j.admCd.slice(5, 10);
    const bun = String(j.lnbrMnnm).padStart(4, "0");
    const ji = String(j.lnbrSlno).padStart(4, "0");

    // 2) 층별현황 가져오기 (Service_v2 사용 추천)
    const flrUrl = `http://apis.data.go.kr/1613000/BldRgstService_v2/getBrFlrOulnInfo?serviceKey=${process.env.BLD_KEY}&sigunguCd=${sigunguCd}&bjdongCd=${bjdongCd}&bun=${bun}&ji=${ji}&numOfRows=1000&pageNo=1`;

    const flrRes = await fetch(flrUrl);
    const flrXml = await flrRes.text();
    
    // API 에러 체크
    if (flrXml.includes("<resultCode>") && !flrXml.includes("<resultCode>00</resultCode>")) {
        const msg = flrXml.match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1] || "API 호출 실패";
        throw new Error(msg);
    }

    // 층 정보 추출
    const items = [...flrXml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    
    // 지상층 숫자만 추출하여 중복 제거 및 정렬
    const floorSet = new Set();
    items.forEach(it => {
      const flrGb = it.match(/<flrGbCdNm>(.*?)<\/flrGbCdNm>/)?.[1] || "";
      const flrNo = it.match(/<flrNo>(.*?)<\/flrNo>/)?.[1];
      
      // 지상층이거나 구분값이 없더라도 양수 층이면 포함 (데이터 누락 방지)
      if (flrNo && Number(flrNo) > 0) {
        floorSet.add(Number(flrNo));
      }
    });

    const sortedFloors = Array.from(floorSet).sort((a, b) => a - b);

    // 3) 티스토리 HTML이 기대하는 형식으로 응답
    return res.status(200).json({
      ok: true,
      build: BUILD,
      road: j.roadAddr,
      jibun: j.jibunAddr,
      keys: { sigunguCd, bjdongCd, bun, ji },
      floors: sortedFloors,
      maxFloor: sortedFloors.length ? sortedFloors[sortedFloors.length - 1] : null
    });

  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}
