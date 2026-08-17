const REFUND_CALCULATOR_TYPES = Object.freeze({
  normal: {
    label: "普通售后｜扣8%服务费",
    formula: "订单价 − 8%服务费 − 已使用天数费用",
  },
  legacy_onhold: {
    label: "原风险共担｜扣8%后剩余金额各承担一半",
    formula: "（订单金额－8%服务费－已使用金额）÷ 2",
  },
  onhold: {
    label: "on-hold｜不扣8%，剩余金额各承担一半",
    formula: "（订单金额－已使用金额）÷ 2",
  },
  kyc: {
    label: "KYC｜销售价减官方成本后按天",
    formula: "（销售价－官方订阅成本）× 未使用天数 ÷ 30",
  },
});

function calculateNormalRefund(orderAmount, usedDays) {
  return orderAmount - orderAmount * 0.08 - (orderAmount / 30) * usedDays;
}

function calculateLegacyOnHoldRefund(orderAmount, usedDays) {
  return calculateNormalRefund(orderAmount, usedDays) / 2;
}

function calculateOnHoldRefund(orderAmount, usedDays) {
  return (orderAmount - (orderAmount / 30) * usedDays) / 2;
}

function calculateKycRefund(orderAmount, usedDays, officialCost) {
  return ((orderAmount - officialCost) * (30 - usedDays)) / 30;
}

function calculatorInputNumber(input, fallback = 0) {
  const value = Number(input?.value);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function calculatorUsedDays(input) {
  return Math.max(0, Math.min(30, calculatorInputNumber(input)));
}

function calculatorMoney(value) {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `¥${safeValue.toFixed(2)}`;
}

function calculatorBreakdown(type, orderAmount, usedDays, officialCost) {
  const usedAmount = (orderAmount / 30) * usedDays;
  const unusedAmount = Math.max(0, orderAmount - usedAmount);
  if (type === "onhold") {
    return [
      ["未使用金额", calculatorMoney(unusedAmount)],
      ["风险共担比例", "50%"],
      ["服务费", "不扣8%服务费"],
    ];
  }
  if (type === "legacy_onhold") {
    return [
      ["8%服务费", calculatorMoney(orderAmount * 0.08)],
      ["已使用金额", calculatorMoney(usedAmount)],
      ["风险共担比例", "50%（原有公式）"],
    ];
  }
  if (type === "kyc") {
    return [
      ["官方订阅成本", calculatorMoney(officialCost)],
      ["未使用天数", `${Math.max(0, 30 - usedDays)}天`],
      ["计算周期", "30天"],
    ];
  }
  return [
    ["8%服务费", calculatorMoney(orderAmount * 0.08)],
    ["已使用金额", calculatorMoney(usedAmount)],
    ["计算周期", "30天"],
  ];
}

function setCalculatorType(type) {
  const typeInput = $("#ctype");
  if (!typeInput || !REFUND_CALCULATOR_TYPES[type]) return;
  typeInput.value = type;
  calc();
}

function calc() {
  const typeInput = $("#ctype");
  const priceInput = $("#price");
  const daysInput = $("#days");
  const costInput = $("#cost");
  if (!typeInput || !priceInput || !daysInput || !costInput) return;

  const type = REFUND_CALCULATOR_TYPES[typeInput.value]
    ? typeInput.value
    : "normal";
  const orderAmount = calculatorInputNumber(priceInput);
  const usedDays = calculatorUsedDays(daysInput);
  const officialCost = calculatorInputNumber(costInput);
  let refund = 0;

  if (type === "normal") {
    refund = calculateNormalRefund(orderAmount, usedDays);
  } else if (type === "legacy_onhold") {
    refund = calculateLegacyOnHoldRefund(orderAmount, usedDays);
  } else if (type === "onhold") {
    refund = calculateOnHoldRefund(orderAmount, usedDays);
  } else {
    refund = calculateKycRefund(orderAmount, usedDays, officialCost);
  }
  refund = Number.isFinite(refund) ? Math.max(0, refund) : 0;

  const calculator = $("#refundCalculator");
  if (calculator) calculator.dataset.calcType = type;
  document.querySelectorAll("[data-calculator-type]").forEach((button) => {
    const selected = button.dataset.calculatorType === type;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  const costField = costInput.closest(".field");
  const usesKycCost = type === "kyc";
  costInput.disabled = !usesKycCost;
  costField?.classList.toggle("is-disabled", !usesKycCost);

  const rawPrice = Number(priceInput.value);
  const rawDays = Number(daysInput.value);
  const rawCost = Number(costInput.value);
  const invalidPrice = !Number.isFinite(rawPrice) || rawPrice < 0;
  const invalidDays = !Number.isFinite(rawDays) || rawDays < 0 || rawDays > 30;
  const invalidCost = usesKycCost &&
    (!Number.isFinite(rawCost) || rawCost < 0);
  priceInput.setAttribute("aria-invalid", String(invalidPrice));
  daysInput.setAttribute("aria-invalid", String(invalidDays));
  costInput.setAttribute("aria-invalid", String(invalidCost));

  const amount = $("#amount");
  const formula = $("#formula");
  const details = $("#calcDetails");
  const validation = $("#calcValidation");
  if (amount) amount.textContent = calculatorMoney(refund);
  if (formula) formula.textContent = REFUND_CALCULATOR_TYPES[type].formula;
  if (details) {
    details.innerHTML = calculatorBreakdown(
      type,
      orderAmount,
      usedDays,
      officialCost,
    )
      .map(
        ([label, value]) =>
          `<div><span>${label}</span><strong>${value}</strong></div>`,
      )
      .join("");
  }
  if (validation) {
    validation.textContent = invalidPrice || invalidDays || invalidCost
      ? "请输入有效的非负金额；已使用天数须在0至30天之间。"
      : "";
  }
}
