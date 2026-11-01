/**
 * Agent report UI sets Customer.ID from URL when AgentView=ON (customer/customer.js init).
 */

export function reportCustomerContextUrl(
  baseUrl: string,
  customerId: string,
): string {
  const base = baseUrl.replace(/\/$/, "");
  const params = new URLSearchParams({
    CustomerID: customerId.trim(),
    AgentView: "ON",
  });
  return `${base}/manager.html?${params.toString()}&v=${String(Date.now())}`;
}

/** In-page bootstrap after navigation (mirrors customer.js init path). */
export function buildReportCustomerContextExpression(
  customerId: string,
): string {
  const id = JSON.stringify(customerId.trim());
  return `(() => {
  sessionStorage.setItem("customerID", ${id});
  return { customerID: ${id}, agentView: "ON" };
})()`;
}

/** Browser `<link rel="dns-prefetch">` for the portal origin (WebView warm-up). */
export function buildDnsPrefetchExpression(baseUrl: string): string {
  const origin = JSON.stringify(new URL(baseUrl).origin);
  return `(() => {
  const href = ${origin};
  if (document.querySelector('link[rel="dns-prefetch"][href="' + href + '"]')) return true;
  const link = document.createElement("link");
  link.rel = "dns-prefetch";
  link.href = href;
  document.head.appendChild(link);
  return true;
})()`;
}
