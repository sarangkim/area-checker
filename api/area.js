export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const address = (req.query.address || "").trim();
  const floor = String(req.query.floor || "").trim();
  const hoInput = (req.query.ho || "").trim(); // "201" or ""

  if (!address || !floor) {
    return res.status(400).json({ ok: false, message: "address와 floor는 필수입니다." });
  }

  const debug = {
    address,
    tried: [],
    picked: null,
  };

  try {
    // 1) JUSO 다건 검색
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

    // 2) 후보들을 돌며: platGbCd 0/1 모두 시도 → item이 나오는 첫 케이스 채택
    let found = null;

    for (const j of jusoList) {
      const admCd = j.admCd;
      if (!admCd || admCd.length < 10) continue;

      const sigunguCd = admCd.slice(0, 5);
      const bjdongCd = admCd.slice(5, 10);
      const bun = String(j.lnbrMnnm || "").padStart(4, "0");
      const ji = String(j.lnbrSlno || "").padStart(4, "0");

      for (const platGbCd of ["0", "1"]) {
        const hubUrl = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrAtchJibunInfo");
        hubUrl.searchParams.set("serviceKey", process.env.BLD_KEY); // 인코딩 금지
        hubUrl.searchParams.set("sigunguCd", sigunguCd);
        hubUrl.searchParams.set("bjdongCd", bjdongCd);
        hubUrl.searchParams.set("bun", bun);
        hubUrl.searchParams.set("ji", ji);
        hubUrl.searchParams.set("platGbCd", platGbCd);
        hubUrl.searchParams.set("numOfRows", "5000");
        hubUrl.searchParams.set("pageNo", "1");

        const hubRes = await fetch(hubUrl.toString());
        const hubXml = await hubRes.text();

        const items = [...hubXml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);

        debug.tried.push({
          jibunAddr: j.jibunAddr,
          roadAddr: j.roadAddrPart1,
          sigunguCd, bjdongCd, bun, ji, platGbCd,
          itemsCount: items.length
        });

        if (items.length) {
          found = { j, sigunguCd, bjdongCd, bun, ji, platGbCd, items };
          break;
        }
      }

      if (found) break;
    }

    if (!found) {
      // 여기까지 왔으면: "이 엔드포인트에는 해당 지번 데이터가 없다"가 거의 확정
      return res.status(404).json({
        ok: false,
        message: "건축HUB(getBrAtchJibunInfo)에서 이 주소로는 호별 데이터(item)를 찾지 못했습니다. (엔드포인트/유형 불일치 가능)",
        debug,
      });
    }

    debug.picked = {
      jibunAddr: found.j.jibunAddr,
      roadAddr: found.j.roadAddrPart1,
      sigunguCd: found.sigunguCd,
      bjdongCd: found.bjdongCd,
      bun: found.bun,
      ji: found.ji,
      platGbCd: found.platGbCd
    };

    // 3) 층/호 매칭
    const wantHo = hoInput ? (hoInput.endsWith("호") ? hoInput : `${hoInput}호`) : null;

    const target = found.items.find(it => {
      const flrNo = it.match(/<flrNo>(.*?)<\/flrNo>/)?.[1]?.trim();
      const hoNm = it.match(/<hoNm>(.*?)<\/hoNm>/)?.[1]?.trim();
      if (String(flrNo) !== String(floor)) return false;
      if (wantHo && hoNm !== wantHo) return false;
      return true;
    });

    if (!target) {
      return res.status(404).json({
        ok: false,
        message: "호별 데이터(item)는 있는데, 입력한 층/호에 해당하는 항목을 찾지 못했습니다.",
        debug,
      });
    }

    const areaStr = target.match(/<area>([\d.]+)<\/area>/)?.[1];
    const areaM2 = Number(areaStr);
    if (!areaM2) {
      return res.status(500).json({ ok: false, message: "면적(area) 값이 없습니다.", debug });
    }

    const areaPyeong = areaM2 / 3.305785;

    return res.status(200).json({
      ok: true,
      address,
      floor,
      ho: hoInput || null,
      area_m2: areaM2,
      area_pyeong: Number(areaPyeong.toFixed(2)),
      source: "건축HUB getBrAtchJibunInfo <area>",
      debug,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message, debug });
  }
}
