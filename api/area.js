export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const address = (req.query.address || "").trim();
  const floor = String(req.query.floor || "").trim();
  const hoInput = (req.query.ho || "").trim();

  if (!address || !floor) {
    return res.status(400).json({ ok: false, message: "address와 floor는 필수입니다." });
  }

  try {
    /* ===============================
       1) JUSO 다건 검색
    =============================== */
    const jusoUrl = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
    jusoUrl.searchParams.set("confmKey", process.env.JUSO_KEY);
    jusoUrl.searchParams.set("currentPage", "1");
    jusoUrl.searchParams.set("countPerPage", "10"); // ★ 다건
    jusoUrl.searchParams.set("keyword", address);
    jusoUrl.searchParams.set("resultType", "json");

    const jusoRes = await fetch(jusoUrl.toString());
    const jusoData = await jusoRes.json();
    const jusoList = jusoData?.results?.juso || [];

    if (!jusoList.length) {
      throw new Error("주소 검색 결과가 없습니다.");
    }

    /* ===============================
       2) 지번 정확 매칭
       - 입력 주소에 '534-9' 같은 지번이 있으면
         jibunAddr에 그 지번이 포함된 것 우선
    =============================== */
    const match = jusoList.find(j =>
      j.jibunAddr && address.includes(j.jibunAddr.split(" ").slice(-1)[0])
    ) || jusoList[0];

    const admCd = match.admCd;
    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd = admCd.slice(5, 10);
    const bun = String(match.lnbrMnnm).padStart(4, "0");
    const ji = String(match.lnbrSlno).padStart(4, "0");

    /* ===============================
       3) 건축HUB 전유공용면적 조회
    =============================== */
    const hubUrl = new URL(
      "https://apis.data.go.kr/1613000/BldRgstHubService/getBrAtchJibunInfo"
    );
    hubUrl.searchParams.set("serviceKey", process.env.BLD_KEY); // ★ 인코딩 금지
    hubUrl.searchParams.set("sigunguCd", sigunguCd);
    hubUrl.searchParams.set("bjdongCd", bjdongCd);
    hubUrl.searchParams.set("bun", bun);
    hubUrl.searchParams.set("ji", ji);
    hubUrl.searchParams.set("platGbCd", "0");
    hubUrl.searchParams.set("numOfRows", "5000");
    hubUrl.searchParams.set("pageNo", "1");

    const hubRes = await fetch(hubUrl.toString());
    const hubXml = await hubRes.text();

    const items = [...hubXml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    if (!items.length) {
      throw new Error("이 지번에는 호별 전유면적 데이터가 없습니다.");
    }

    /* ===============================
       4) 층 / 호 매칭
    =============================== */
    const target = items.find(it => {
      const flrNo = it.match(/<flrNo>(.*?)<\/flrNo>/)?.[1];
      const hoNm = it.match(/<hoNm>(.*?)<\/hoNm>/)?.[1];
      if (String(flrNo) !== floor) return false;
      if (hoInput && hoNm !== `${hoInput}호`) return false;
      return true;
    });

    if (!target) {
      throw new Error("해당 층/호 정보를 찾지 못했습니다.");
    }

    const area = Number(target.match(/<area>([\d.]+)<\/area>/)?.[1]);
    if (!area) throw new Error("면적 정보가 없습니다.");

    const pyeong = area / 3.305785;

    return res.status(200).json({
      ok: true,
      address,
      jibun: match.jibunAddr,
      floor,
      ho: hoInput || null,
      area_m2: area,
      area_pyeong: Number(pyeong.toFixed(2)),
      source: "건축HUB 전유면적(호별)",
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message,
    });
  }
}
