// Big screens: the page's content grows with the window up to 1.33x, then
// stops and the margins take the rest; the bar and the footer keep their size
// and line up with it (Kate, Sep 24: "keep the header but just scale the
// content", "up to 1.33x"). 1x at her laptop window, 1426 x 703; the height
// counts too, so the top of the home page still fits a wide, short window.
(() => {
  const root = document.documentElement;
  const fit = () => {
    const z = Math.min(innerWidth / 1426, innerHeight / 703, 1.33);
    root.style.setProperty("--grow", z > 1.01 ? z.toFixed(3) : "1");
  };
  addEventListener("resize", fit);
  fit();
})();
