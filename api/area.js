export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { address, floor, ho } = req.query;

  if (!address || !floor) {
    return res.status(400).json({
      ok: false,
      message: "address와 floor는 필수입니다",
    });
  }

  try {
    // ⚠️ 지금은 테스트용 더미 값
    // 다음 단계에서 실제 건축HUB API 연결
    const exampleAreaM2 = 39.53;

    const pyeong = exampleAreaM2 / 3.305785;

    return res.status(200).json({
      ok: true,
      address,
      floor,
      ho: ho || null,
      area_m2: exampleAreaM2,
      area_pyeong: Number(pyeong.toFixed(2)),
      source: "전유면적(area)",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e.message,
    });
  }
}
