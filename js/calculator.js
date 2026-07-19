function calc() {
        let p = +($("#price")?.value || 0),
          d = Math.max(0, Math.min(30, +($("#days")?.value || 0))),
          c = +($("#cost")?.value || 0),
          t = $("#ctype")?.value || "normal",
          a = 0,
          f = "";
        if (t === "normal") {
          a = p - p * 0.08 - (p / 30) * d;
          f = "订单价 − 8% 服务费 − 已用天数费用";
        } else if (t === "onhold") {
  a = (p - p * 0.08 - (p / 30) * d) / 2;
  f = "（订单金额－订单金额 × 8%－订单金额 ÷ 30 × 已使用天数）÷ 2";
} else {
          a = Math.max(0, ((p - c) * (30 - d)) / 30);
          f = "（销售价 − 官方订阅成本）× 未使用天数 ÷ 30";
        }
        a = Math.max(0, a);
        if ($("#amount")) $("#amount").textContent = "¥" + a.toFixed(2);
        if ($("#formula")) $("#formula").textContent = f;
      }
