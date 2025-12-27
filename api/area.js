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
    /* =========================
       1) JUSO 주소 → 지번
    ========================= */
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

    /* =========================
       2) 전유부 목록 조회
    ========================= */
    const exposUrl = new URL(
      "https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposInfo"
    );
    exposUrl.searchParams.set("serviceKey", process.env.BLD_KEY);
    exposUrl.searchParams.set("sigunguCd", sigunguCd);
    exposUrl.searchParams.set("bjdongCd", bjdongCd);
    exposUrl.searchParams.set("bun", bun);
    exposUrl.searchParams.set("ji", ji);
    exposUrl.searchParams.set("numOfRows", "5000");
    exposUrl.searchParams.set("pageNo", "1");

    const exposRes = await fetch(exposUrl.toString());
    const exposXml = await exposRes.text();

    const items = [...exposXml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    if (!items.length) throw new Error("전유부(호별) 데이터가 없습니다.");

    const wantHo = hoInput ? (hoInput.endsWith("호") ? hoInput : `${hoInput}호`) : null;

    const target = items.find(it => {
      const flrNo = getTag(it, "flrNo");
      const hoNm = getTag(it, "hoNm");
      if (String(flrNo) !== floor) return false;
      if (wantHo && hoNm !== wantHo) return false;
      return true;
    });

    if (!target) throw new Error("해당 층/호를 찾지 못했습니다.");

    const mgmBldrgstPk = getTag(target, "mgmBldrgstPk");
    if (!mgmBldrgstPk) throw new Error("관리건축물대장PK가 없습니다.");

    /* =========================
       3) 전유부 상세 (면적!)
       getBrBasisOulnInfo
    ========================= */
  const detailUrl = new URL(
      "https://apis.data.go.kr/1613000/BldRgstHubService/getBrBasisOulnInfo"
    );
    detailUrl.searchParams.set("serviceKey", process.env.BLD_KEY);
    detailUrl.searchParams.set("mgmBldrgstPk", mgmBldrgstPk);
    
    // ★ 반드시 같이 넣어야 함
    detailUrl.searchParams.set("sigunguCd", sigunguCd);
    detailUrl.searchParams.set("bjdongCd", bjdongCd);
    detailUrl.searchParams.set("bun", bun);
    detailUrl.searchParams.set("ji", ji);
    
    detailUrl.searchParams.set("numOfRows", "1");
    detailUrl.searchParams.set("pageNo", "1");


    const detailRes = await fetch(detailUrl.toString());
    const detailXml = await detailRes.text();

    const detailItem = detailXml.match(/<item>([\s\S]*?)<\/item>/)?.[1];
    if (!detailItem) throw new Error("전유부 상세 정보가 없습니다.");

    const areaM2 = Number(getTag(detailItem, "excluUseAr"));
    if (!areaM2) throw new Error("전유면적(excluUseAr) 정보가 없습니다.");

    const areaPyeong = areaM2 / 3.305785;

    return res.status(200).json({
      ok: true,
      address,
      jibun: j.jibunAddr,
      floor,
      ho: hoInput || null,
      area_m2: areaM2,
      area_pyeong: Number(areaPyeong.toFixed(2)),
      source: "건축HUB 전유부 상세(getBrBasisOulnInfo)",
    });

  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || "";
}
