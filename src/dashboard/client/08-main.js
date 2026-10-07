// Start-up: draw the page, then show any message the server passed along (e.g. after connecting Google).
render();
if (S.flash) {
  snack(S.flash, { long: true });
  const url = new URL(location.href);
  url.searchParams.delete("flash");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
