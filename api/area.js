export default async function handler(req, res) {
  // CORS 허용 (티스토리에서 호출 가능하게)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  const address = (req.query.address || "").trim();
  const floor = String(req.query.floor || "").trim();   // "2"
  const hoInput = (req.query.ho || "").trim();          // "201" 또는 "201호"
  const dongInput = (req.query.dong || "").trim();      // 선택: "A동", "101", "302" 등

  if (!address || !floor) {
    return res.status(400).json({ ok: false, message: "address와 floor는 필수입니다." });
  }

  try {
    // 1) 주소 → 지번코드 변환 (JUSO 검색 API)
    const jusoUrl = new URL("https://business.juso.go.kr/addrlink/addrLinkApi.do");
    jusoUrl.searchParams.set("confmKey", process.env.JUSO_KEY);
    jusoUrl.searchParams.set("currentPage", "1");
    jusoUrl.searchParams.set("countPerPage", "1");
    jusoUrl.searchParams.set("keyword", address);
    jusoUrl.searchParams.set("resultType", "json");

    const jusoRes = await fetch(jusoUrl.toString());
    const jusoData = await jusoRes.json();

    const juso = jusoData?.results?.juso?.[0];
    if (!juso) throw new Error("주소 검색 결과가 없습니다. 주소를 더 정확히 입력해 주세요.");

    // admCd(행정코드)에서 시군구/법정동 분리
    const admCd = juso.admCd; // 예: 1150010200...
    if (!admCd || admCd.length < 10) throw new Error("주소 응답(admCd)이 올바르지 않습니다.");

    const sigunguCd = admCd.slice(0, 5);
    const bjdongCd = admCd.slice(5, 10);

    // 지번 번/지
    const bun = String(juso.lnbrMnnm || "").padStart(4, "0");
    const ji = String(juso.lnbrSlno || "").padStart(4, "0");

    // 2) 건축HUB 전유공용면적(호별면적 포함) 조회
    // serviceKey는 "일반 인증키(Decoding)"를 환경변수에 넣는 걸 권장
    const hubUrl = new URL("https://apis.data.go.kr/1613000/BldRgstHubService/getBrAtchJibunInfo");
    hubUrl.searchParams.set("serviceKey", encodeURIComponent(process.env.BLD_KEY));
    hubUrl.searchParams.set("sigunguCd", sigunguCd);
    hubUrl.searchParams.set("bjdongCd", bjdongCd);
    hubUrl.searchParams.set("bun", bun);
    hubUrl.searchParams.set("ji", ji);
    hubUrl.searchParams.set("numOfRows", "5000");
    hubUrl.searchParams.set("pageNo", "1");

    // 동/호로 조회를 줄이고 싶으면(옵션) 아래 주석 해제 가능
    // if (dongInput) hubUrl.searchParams.set("dongNm", dongInput);
    // if (hoInput) hubUrl.searchParams.set("hoNm", normalizeHo(hoInput));

    const hubRes = await fetch(hubUrl.toString());
    const hubXml = await hubRes.text();

    // 에러 체크
    const resultCode = hubXml.match(/<resultCode>(.*?)<\/resultCode>/)?.[1];
    if (resultCode && resultCode !== "00") {
      const msg = hubXml.match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1] || "건축HUB 조회 오류";
      throw new Error(`건축HUB 오류: ${msg}`);
    }

    const items = [...hubXml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    if (!items.length) throw new Error("전유부(호별) 데이터가 없습니다. (해당 지번에 데이터 없음)");

    const wantHo = hoInput ? normalizeHo(hoInput) : null;
    const wantDong = dongInput ? normalizeDong(dongInput) : null;

    // 3) 층/호/동 매칭해서 area 추출
    const matched = items.find((it) => {
      const flrNo = it.match(/<flrNo>(.*?)<\/flrNo>/)?.[1]?.trim();   // "2"
      const hoNm = it.match(/<hoNm>(.*?)<\/hoNm>/)?.[1]?.trim();      // "201호"
      const dongNm = it.match(/<dongNm>(.*?)<\/dongNm>/)?.[1]?.trim(); // "302" 등

      if (String(flrNo) !== String(floor)) return false;
      if (wantHo && normalizeHo(hoNm || "") !== wantHo) return false;
      if (wantDong && normalizeDong(dongNm || "") !== wantDong) return false;

      // 전유/공용 구분이 있는 경우 "전유"만 잡고 싶으면 아래 조건 추가 가능
      // const exposGb = it.match(/<exposPubuseGbCdNm>(.*?)<\/exposPubuseGbCdNm>/)?.[1]?.trim();
      // if (exposGb && exposGb !== "전유") return false;

      return true;
    });

    if (!matched) {
      throw new Error("해당 층/호(동) 정보를 찾지 못했습니다. (층/호/동 입력 확인)");
    }

    const areaStr = matched.match(/<area>([\d.]+)<\/area>/)?.[1];
    const areaM2 = Number(areaStr);
    if (!areaM2) throw new Error("면적(area) 값이 없습니다.");

    const areaPyeong = areaM2 / 3.305785;

    return res.status(200).json({
      ok: true,
      input: { address, floor, ho: hoInput || null, dong: dongInput || null },
      normalized: {
        sigunguCd, bjdongCd, bun, ji,
        roadAddr: juso.roadAddrPart1 || address,
        jibunAddr: juso.jibunAddr || null,
      },
      area_m2: areaM2,
      area_pyeong: Number(areaPyeong.toFixed(2)),
      source: "건축HUB getBrAtchJibunInfo <area> (전유면적/호별)",
    });

  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

function normalizeHo(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  // "201" -> "201호", "201호" -> "201호"
  return s.endsWith("호") ? s : `${s}호`;
}

function normalizeDong(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  // "302동" -> "302", "302" -> "302"
  return s.replace(/동$/g, "");
}
