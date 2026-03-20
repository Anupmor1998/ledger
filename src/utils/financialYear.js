const INDIA_TIME_ZONE = "Asia/Kolkata";

function getDateParts(dateValue) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid date");
  }

  const formatter = new Intl.DateTimeFormat("en-IN", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
  };
}

function getFinancialYearStartYear(dateValue = new Date()) {
  const { year, month } = getDateParts(dateValue);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error("unable to derive financial year");
  }
  return month >= 4 ? year : year - 1;
}

function getFinancialYearLabel(startYear) {
  const year = Number(startYear);
  if (!Number.isInteger(year)) {
    return "";
  }
  const nextShortYear = String((year + 1) % 100).padStart(2, "0");
  return `${year}-${nextShortYear}`;
}

module.exports = {
  getFinancialYearStartYear,
  getFinancialYearLabel,
};
