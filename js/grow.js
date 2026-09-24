// Big screens: the page grows with the window up to 1.15x, then stops and the
// margins take the rest; the bar, the content and the footer grow together
// (Kate, Sep 24: 1.33x "looks SO BIG on my studio display"; "up to 1.15x, all
// together"). 1x at her laptop window, 1426 x 703; the height counts too, so a
// wide, short window does not grow past what fits.
(() => {
  const root = document.documentElement;
  const fit = () => {
    const z = Math.min(innerWidth / 1426, innerHeight / 703, 1.15);
    const bar = Math.min(z, window.EXCHANGE_BAR_CAP || 1.15);
    root.style.setProperty("--grow", z > 1.01 ? z.toFixed(3) : "1");
    root.style.setProperty("--grow-bar", bar > 1.01 ? bar.toFixed(3) : "1");
  };
  addEventListener("resize", fit);
  window.exchangeFit = fit;
  fit();
})();
