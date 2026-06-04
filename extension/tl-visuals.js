(function () {
  const root = document.documentElement;
  const wide = window.innerWidth >= 760;

  const rand = (min, max) => Math.round(min + Math.random() * (max - min));
  const jitter = (base, spread) => rand(base - spread, base + spread);
  const placements = [
    {
      x: `left ${rand(wide ? -5 : -13, wide ? 4 : -4)}vw`,
      y: `top ${jitter(wide ? 20 : 16, 7)}vh`,
      size: `${rand(wide ? 190 : 150, wide ? 260 : 220)}px`,
    },
    {
      x: `right ${rand(wide ? -5 : -13, wide ? 4 : -4)}vw`,
      y: `top ${jitter(wide ? 24 : 20, 7)}vh`,
      size: `${rand(wide ? 190 : 150, wide ? 260 : 220)}px`,
    },
    {
      x: `left ${rand(wide ? 9 : -7, wide ? 17 : 2)}vw`,
      y: `bottom ${jitter(wide ? 12 : 8, 7)}vh`,
      size: `${rand(wide ? 160 : 128, wide ? 230 : 190)}px`,
    },
    {
      x: `right ${rand(wide ? 9 : -7, wide ? 17 : 2)}vw`,
      y: `bottom ${jitter(wide ? 14 : 10, 7)}vh`,
      size: `${rand(wide ? 160 : 128, wide ? 230 : 190)}px`,
    },
  ];

  placements.forEach((placement, index) => {
    const n = index + 1;
    root.style.setProperty(`--tl-jelly-${n}-x`, placement.x);
    root.style.setProperty(`--tl-jelly-${n}-y`, placement.y);
    root.style.setProperty(`--tl-jelly-${n}-size`, placement.size);
  });
})();
