(() => {
  const RED = "#e11d48";
  const FONT = "600 13px Poppins, Inter, system-ui, sans-serif";
  const LINE_HEIGHT = 18;
  const SERVER = document.currentScript?.src
    ? new URL(document.currentScript.src).origin
    : "http://localhost:3999";

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  function toElement(target) {
    return typeof target === "string" ? document.querySelector(target) : target;
  }

  function rect(target) {
    const box = toElement(target).getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height
    };
  }

  function union(...targets) {
    const isBox = target =>
      typeof target === "object" && !(target instanceof Element) && "left" in target;
    const boxes = targets.map(target => (isBox(target) ? target : rect(target)));
    const left = Math.min(...boxes.map(box => box.left));
    const top = Math.min(...boxes.map(box => box.top));
    const right = Math.max(...boxes.map(box => box.right));
    const bottom = Math.max(...boxes.map(box => box.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function center(box) {
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }

  function byText(selector, text) {
    return [...document.querySelectorAll(selector)].find(element =>
      element.textContent.trim().includes(text)
    );
  }

  async function waitFor(predicate, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = predicate();
      if (value) return value;
      await wait(200);
    }
    throw new Error("waitFor: tempo esgotado");
  }

  function pointerDown(target) {
    toElement(target).dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })
    );
  }

  function click(target, modifiers = {}) {
    const element = toElement(target);
    const init = { bubbles: true, cancelable: true, button: 0, ...modifiers };
    element.dispatchEvent(new MouseEvent("mousedown", init));
    element.dispatchEvent(new MouseEvent("mouseup", init));
    element.dispatchEvent(new MouseEvent("click", init));
  }

  function freezeAnimations() {
    const selectors = [
      "[data-radix-popper-content-wrapper] > *",
      '[role="menu"]',
      '[role="dialog"]',
      '[role="listbox"]',
      '[role="tooltip"]',
      '[data-state="open"][data-side]'
    ];
    for (const element of document.querySelectorAll(selectors.join(","))) {
      element.style.animation = "none";
      element.style.transition = "none";
      element.style.opacity = "1";
      element.style.transform = "none";
    }
  }

  function scrollState() {
    return [document.scrollingElement, ...document.querySelectorAll("*")]
      .filter(element => element && element.scrollTop > 0)
      .map(element => ({ element: element.tagName, scrollTop: Math.round(element.scrollTop) }));
  }

  function measureLabel(lines) {
    const context = document.createElement("canvas").getContext("2d");
    context.font = FONT;
    const textLines = [].concat(lines);
    const width = Math.max(...textLines.map(line => context.measureText(line).width)) + 22;
    return { width, height: textLines.length * LINE_HEIGHT + 12 };
  }

  function drawBox(context, box) {
    context.strokeStyle = RED;
    context.lineWidth = 2.5;
    context.setLineDash([6, 4]);
    context.beginPath();
    context.roundRect(box.left - 5, box.top - 5, box.width + 10, box.height + 10, 10);
    context.stroke();
    context.setLineDash([]);
  }

  function drawArrow(context, from, to, withHead) {
    context.strokeStyle = RED;
    context.fillStyle = RED;
    context.lineWidth = 3;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    if (!withHead) return;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const size = 13;
    context.beginPath();
    context.moveTo(to.x, to.y);
    context.lineTo(to.x - size * Math.cos(angle - 0.45), to.y - size * Math.sin(angle - 0.45));
    context.lineTo(to.x - size * Math.cos(angle + 0.45), to.y - size * Math.sin(angle + 0.45));
    context.closePath();
    context.fill();
  }

  function drawLabel(context, lines, at) {
    const textLines = [].concat(lines);
    const { width, height } = measureLabel(textLines);
    context.font = FONT;
    context.fillStyle = RED;
    context.beginPath();
    context.roundRect(at.x, at.y, width, height, 12);
    context.fill();
    context.fillStyle = "#fff";
    textLines.forEach((line, index) =>
      context.fillText(line, at.x + 11, at.y + 19 + index * LINE_HEIGHT)
    );
  }

  async function shot(name, region, notes = [], options = {}) {
    const {
      pad = 16,
      marginRight = 0,
      marginBottom = 0,
      ratio = 2,
      background = "#f5f5f7"
    } = options;
    if (scrollY !== 0)
      throw new Error(`a página está rolada (scrollY=${scrollY}); volte ao topo antes de capturar`);

    freezeAnimations();
    await wait(50);

    const full = await window.htmlToImage.toCanvas(document.documentElement, {
      pixelRatio: ratio,
      width: innerWidth,
      height: innerHeight,
      cacheBust: true
    });

    const x = Math.max(0, region.left - pad);
    const y = Math.max(0, region.top - pad);
    const width = Math.min(innerWidth - x, region.width + pad * 2);
    const height = Math.min(innerHeight - y, region.height + pad * 2);

    const output = document.createElement("canvas");
    output.width = (width + marginRight) * ratio;
    output.height = (height + marginBottom) * ratio;
    const context = output.getContext("2d");
    context.fillStyle = background;
    context.fillRect(0, 0, output.width, output.height);
    context.drawImage(
      full,
      x * ratio,
      y * ratio,
      width * ratio,
      height * ratio,
      0,
      0,
      width * ratio,
      height * ratio
    );
    context.scale(ratio, ratio);
    context.translate(-x, -y);

    for (const note of notes) {
      if (note.box) drawBox(context, note.box);
      if (note.from && note.to) drawArrow(context, note.from, note.to, !note.noHead);
      if (note.label) drawLabel(context, note.label, note.at);
    }

    const response = await fetch(`${SERVER}/save?name=${encodeURIComponent(name)}`, {
      method: "POST",
      body: output.toDataURL("image/png")
    });
    return response.json();
  }

  window.__cap = {
    wait,
    waitFor,
    rect,
    union,
    center,
    byText,
    pointerDown,
    click,
    freezeAnimations,
    scrollState,
    measureLabel,
    shot
  };
})();
