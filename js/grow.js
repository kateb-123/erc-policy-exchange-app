// Big screens: the page's content grows with the window up to 1.33x, then
// stops and the margins take the rest (Kate, Sep 24: "up to 1.33x"). The bar
// and the footer grow too, but stop sooner, at 1.15x (Kate, Sep 24: "make the
// header footer responsive to screen size, but ... to a certain amount"), and
// their edges still line up with the content. 1x at her laptop window, 1426 x
// 703; the height counts too, so the top of the home page still fits a wide,
// short window.
(() => {
  const root = document.documentElement;
  const fit = () => {
    const z = Math.min(innerWidth / 1426, innerHeight / 703, 1.33);
    const bar = Math.min(z, window.EXCHANGE_BAR_CAP || 1.15);
    root.style.setProperty("--grow", z > 1.01 ? z.toFixed(3) : "1");
    root.style.setProperty("--grow-bar", bar > 1.01 ? bar.toFixed(3) : "1");
  };
  addEventListener("resize", fit);
  window.exchangeFit = fit;
  fit();
})();
