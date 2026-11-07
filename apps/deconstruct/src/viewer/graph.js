/**
 * 확인 페이지의 그래프 탭. /deconstruct가 돌려주는 contents와 weights만으로 그린다.
 * 노드가 수백 개여도 부드럽도록 DOM 대신 Canvas에 그리고, 간단한 힘 기반 배치를 직접 계산한다.
 * 임계값 슬라이더는 프론트엔드가 weights를 거르는 동작을 그대로 재현한다.
 */
window.createGraphView = function createGraphView({ canvas, panel, status, labels, relayout, fit }) {
  const MAX_EDGES = 12000; // 임계값을 낮추면 간선이 수만 개가 된다. 강한 간선부터 이만큼만 그린다.
  const MAX_NEIGHBORS = 10;
  const LABEL_QUOTA = 12;
  const ctx = canvas.getContext("2d");

  let nodes = [];
  let allWeights = [];
  let edges = [];
  let adjacency = [];
  let threshold = 0.8;
  let alpha = 0;
  let visible = false;
  let frame = null;
  let transform = { x: 0, y: 0, k: 1 };
  let autoFit = true;
  let selected = null;
  let hovered = null;
  let pointer = null;
  let colors = {};
  const images = new Map();

  function readColors() {
    const style = getComputedStyle(document.documentElement);
    const read = (name) => style.getPropertyValue(name).trim();
    colors = {
      text: read("--accent"), img: read("--warn"), edge: read("--muted"), label: read("--text"),
      muted: read("--muted"), bg: read("--bg"), ring: read("--text"),
    };
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    readColors();
    schedule();
  });

  const shorten = (text, length) => (text.length > length ? `${text.slice(0, length)}…` : text);
  const labelOf = (node) => (node.data.type === "img" ? node.data.meta.description || "이미지" : node.data.content);

  /** 프론트엔드가 할 일과 같다: 임계값 이상인 간선만 남긴다. */
  function rebuildEdges() {
    const kept = allWeights.filter((edge) => edge[2] >= threshold).sort((a, b) => b[2] - a[2]);
    const shown = kept.slice(0, MAX_EDGES);
    const range = Math.max(1 - threshold, 0.001);
    edges = shown.map(([source, target, weight]) => ({
      source, target, weight, strength: Math.min(1, Math.max(0, (weight - threshold) / range)),
    }));
    adjacency = nodes.map(() => []);
    for (const edge of edges) {
      adjacency[edge.source].push({ index: edge.target, weight: edge.weight });
      adjacency[edge.target].push({ index: edge.source, weight: edge.weight });
    }
    nodes.forEach((node, index) => {
      node.degree = adjacency[index].length;
      node.r = (node.data.type === "img" ? 7 : 4) + Math.min(9, Math.sqrt(node.degree) * 1.6);
    });
    const connected = nodes.filter((node) => node.degree > 0).length;
    const capped = kept.length > shown.length ? ` · 강한 간선 ${MAX_EDGES.toLocaleString()}개만 표시` : "";
    status.textContent = `임계값 ${threshold.toFixed(2)} · 간선 ${kept.length.toLocaleString()}개 · 연결된 노드 ${connected}/${nodes.length}개${capped}`;
    if (selected !== null) renderPanel();
  }

  /** 초기 배치는 난수 없이 나선형으로 두어 같은 데이터면 같은 그림이 나오게 한다. */
  function placeNodes() {
    const golden = Math.PI * (3 - Math.sqrt(5));
    nodes.forEach((node, index) => {
      const radius = 16 * Math.sqrt(index + 1);
      node.x = radius * Math.cos(index * golden);
      node.y = radius * Math.sin(index * golden);
      node.vx = 0;
      node.vy = 0;
    });
  }

  function tick() {
    const count = nodes.length;
    for (let i = 0; i < count; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < count; j += 1) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = dx * dx + dy * dy;
        if (distance === 0) {
          dx = (i - j) * 0.01;
          dy = 0.01;
          distance = dx * dx + dy * dy;
        }
        if (distance > 250000) continue;
        const force = (700 * alpha) / distance;
        a.vx += dx * force;
        a.vy += dy * force;
        b.vx -= dx * force;
        b.vy -= dy * force;
      }
    }
    for (const edge of edges) {
      const a = nodes[edge.source];
      const b = nodes[edge.target];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = 30 + 90 * (1 - edge.strength);
      const pull = (((distance - rest) / distance) * alpha * (0.25 + 0.75 * edge.strength)) / Math.max(1, Math.min(a.degree, b.degree));
      a.vx += dx * pull;
      a.vy += dy * pull;
      b.vx -= dx * pull;
      b.vy -= dy * pull;
    }
    for (const node of nodes) {
      // 연결이 없는 노드는 약하게 끌어 와 화면 밖으로 흩어지지 않게 한다.
      const gravity = node.degree ? 0.012 : 0.03;
      node.vx -= node.x * gravity * alpha;
      node.vy -= node.y * gravity * alpha;
      if (pointer?.mode === "drag" && pointer.node === node) continue;
      node.vx *= 0.6;
      node.vy *= 0.6;
      node.x += node.vx;
      node.y += node.vy;
    }
    alpha *= 0.985;
  }

  function fitToView() {
    const { width, height } = canvas.getBoundingClientRect();
    if (nodes.length === 0 || width === 0) return; // 탭이 숨겨져 있으면 열 때 다시 맞춘다.
    const xs = nodes.map((node) => node.x);
    const ys = nodes.map((node) => node.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const k = Math.min(2, (width - 60) / Math.max(maxX - minX, 1), (height - 60) / Math.max(maxY - minY, 1));
    transform = { k, x: width / 2 - (k * (minX + maxX)) / 2, y: height / 2 - (k * (minY + maxY)) / 2 };
  }

  const isNeighbor = (index) => selected !== null && (index === selected || adjacency[selected].some((n) => n.index === index));

  function imageFor(node) {
    if (node.data.type !== "img") return null;
    if (!images.has(node.index)) {
      const image = new Image();
      image.onload = schedule;
      image.src = node.data.content;
      images.set(node.index, image);
    }
    const image = images.get(node.index);
    return image.complete && image.naturalWidth > 0 ? image : null;
  }

  /** 전체를 축소해 볼 때도 노드와 썸네일이 알아볼 만한 크기를 유지하게 한다. */
  const radiusOf = (node) => node.r * Math.max(1, 0.9 / transform.k);

  function drawNode(node) {
    const faded = selected !== null && !isNeighbor(node.index);
    const r = radiusOf(node);
    ctx.globalAlpha = faded ? 0.15 : 1;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    const image = transform.k * r >= 6 ? imageFor(node) : null;
    if (image) {
      ctx.save();
      ctx.clip();
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      const scale = (r * 2) / Math.min(image.naturalWidth, image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      ctx.drawImage(image, node.x - width / 2, node.y - height / 2, width, height);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.lineWidth = 1.5 / transform.k;
      ctx.strokeStyle = colors.img;
      ctx.stroke();
    } else {
      ctx.fillStyle = node.data.type === "img" ? colors.img : colors.text;
      ctx.fill();
    }
    if (node.index === selected || node === hovered) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 2.5 / transform.k, 0, Math.PI * 2);
      ctx.lineWidth = 2 / transform.k;
      ctx.strokeStyle = colors.ring;
      ctx.stroke();
    }
  }

  function drawLabel(node) {
    const size = 12 / transform.k;
    ctx.font = `${size}px -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const x = node.x + radiusOf(node) + 4 / transform.k;
    const text = shorten(labelOf(node), node.index === selected || node === hovered ? 44 : 22);
    ctx.lineWidth = 3 / transform.k;
    ctx.strokeStyle = colors.bg;
    ctx.strokeText(text, x, node.y);
    ctx.fillStyle = colors.label;
    ctx.fillText(text, x, node.y);
  }

  function draw() {
    const { width, height } = canvas.getBoundingClientRect();
    const ratio = devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    // 강도별로 묶어 그려 간선이 많아도 stroke 호출을 줄인다.
    const BUCKETS = 4;
    ctx.strokeStyle = colors.edge;
    for (let bucket = 0; bucket < BUCKETS; bucket += 1) {
      ctx.beginPath();
      for (const edge of edges) {
        if (Math.min(BUCKETS - 1, Math.floor(edge.strength * BUCKETS)) !== bucket) continue;
        if (selected !== null && edge.source !== selected && edge.target !== selected) continue;
        const a = nodes[edge.source];
        const b = nodes[edge.target];
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.globalAlpha = selected !== null ? 0.75 : 0.12 + bucket * 0.18;
      ctx.lineWidth = (0.6 + bucket * 0.7) / transform.k;
      ctx.stroke();
    }

    for (const node of nodes) drawNode(node);

    ctx.globalAlpha = 1;
    // 라벨이 겹치지 않도록 연결이 많은 노드부터 일부만 달고, 확대할수록 늘린다.
    const quota = labels.checked && selected === null ? Math.round(LABEL_QUOTA * Math.max(1, transform.k * transform.k)) : 0;
    const ranked = [...nodes].filter((node) => node.degree > 0).sort((a, b) => b.degree - a.degree).slice(0, quota);
    const labelled = new Set(ranked);
    for (const node of nodes) {
      const important = node.index === selected || node === hovered || (selected !== null && isNeighbor(node.index));
      if (important || labelled.has(node)) drawLabel(node);
    }
  }

  function step() {
    frame = null;
    if (!visible) return;
    if (alpha > 0.01) {
      tick();
      if (autoFit) fitToView();
    }
    draw();
    if (alpha > 0.01) schedule();
  }

  function schedule() {
    if (visible && frame === null) frame = requestAnimationFrame(step);
  }

  function reheat(value) {
    alpha = Math.max(alpha, value);
    schedule();
  }

  function resize() {
    const { width, height } = canvas.getBoundingClientRect();
    const ratio = devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    if (autoFit) fitToView();
    // 크기를 바꾸면 캔버스가 지워지므로 다음 프레임을 기다리지 않고 바로 그린다.
    if (visible && width > 0) draw();
  }
  new ResizeObserver(resize).observe(canvas);

  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function renderPanel() {
    panel.replaceChildren();
    if (selected === null) {
      panel.append(make("p", "graph-hint", "노드를 누르면 내용과 연결된 노드를 볼 수 있습니다."));
      return;
    }
    const node = nodes[selected];
    const { data } = node;
    panel.append(make("p", "graph-kind", `#${selected} · ${data.type === "img" ? "이미지" : "텍스트"} · 연결 ${node.degree}개`));
    if (data.type === "img") {
      const image = make("img", "graph-image");
      image.src = data.content;
      image.alt = data.meta.description || "";
      panel.append(image, make("p", "graph-content", data.meta.description || "설명 없음"));
    } else {
      panel.append(make("p", "graph-content", data.content));
    }

    const list = make("ol", "graph-neighbors");
    const neighbors = [...adjacency[selected]].sort((a, b) => b.weight - a.weight).slice(0, MAX_NEIGHBORS);
    if (neighbors.length === 0) panel.append(make("p", "graph-hint", "이 임계값에서는 연결된 노드가 없습니다."));
    for (const { index, weight } of neighbors) {
      const button = make("button");
      button.type = "button";
      button.append(make("b", "", weight.toFixed(2)), ` ${shorten(labelOf(nodes[index]), 50)}`);
      button.addEventListener("click", () => select(index, true));
      const item = make("li");
      item.append(button);
      list.append(item);
    }
    if (neighbors.length) panel.append(list);
  }

  function select(index, center = false) {
    selected = index;
    if (center && index !== null) {
      const { width, height } = canvas.getBoundingClientRect();
      autoFit = false;
      transform.x = width / 2 - nodes[index].x * transform.k;
      transform.y = height / 2 - nodes[index].y * transform.k;
    }
    renderPanel();
    schedule();
  }

  function nodeAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left - transform.x) / transform.k;
    const y = (clientY - rect.top - transform.y) / transform.k;
    const slack = 3 / transform.k;
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      const reach = radiusOf(node) + slack;
      if ((node.x - x) ** 2 + (node.y - y) ** 2 <= reach * reach) return node;
    }
    return null;
  }

  canvas.addEventListener("pointerdown", (event) => {
    const node = nodeAt(event.clientX, event.clientY);
    canvas.setPointerCapture(event.pointerId);
    pointer = { mode: node ? "drag" : "pan", node, x: event.clientX, y: event.clientY, moved: false };
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!pointer) {
      const node = nodeAt(event.clientX, event.clientY);
      if (node !== hovered) {
        hovered = node;
        canvas.style.cursor = node ? "pointer" : "grab";
        schedule();
      }
      return;
    }
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) pointer.moved = true;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    autoFit = false;
    if (pointer.mode === "drag") {
      pointer.node.x += dx / transform.k;
      pointer.node.y += dy / transform.k;
      reheat(0.15);
    } else {
      transform.x += dx;
      transform.y += dy;
    }
    schedule();
  });

  const release = (event) => {
    if (pointer && !pointer.moved && event.type === "pointerup") select(pointer.node ? pointer.node.index : null);
    pointer = null;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => {
    if (hovered) {
      hovered = null;
      schedule();
    }
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const k = Math.min(8, Math.max(0.1, transform.k * Math.exp(-event.deltaY * 0.0015)));
      transform.x = px - ((px - transform.x) * k) / transform.k;
      transform.y = py - ((py - transform.y) * k) / transform.k;
      transform.k = k;
      autoFit = false;
      schedule();
    },
    { passive: false },
  );

  labels.addEventListener("change", schedule);
  fit.addEventListener("click", () => {
    autoFit = true;
    fitToView();
    schedule();
  });
  relayout.addEventListener("click", () => {
    placeNodes();
    autoFit = true;
    alpha = 0;
    reheat(1);
  });

  readColors();
  renderPanel();

  return {
    setData(contents, weights, initialThreshold) {
      nodes = contents.map((data, index) => ({ data, index, x: 0, y: 0, vx: 0, vy: 0, r: 5, degree: 0 }));
      allWeights = weights;
      threshold = initialThreshold;
      images.clear();
      selected = null;
      hovered = null;
      autoFit = true;
      placeNodes();
      rebuildEdges();
      renderPanel();
      // 탭을 열었을 때 노드가 한참 움직이지 않도록 미리 배치를 끝내 둔다.
      alpha = 1;
      while (alpha > 0.01) tick();
      fitToView();
      schedule();
    },
    setThreshold(value) {
      if (value === threshold || nodes.length === 0) return;
      threshold = value;
      rebuildEdges();
      reheat(0.5);
    },
    setVisible(value) {
      visible = value;
      if (value) {
        readColors();
        resize();
      }
    },
  };
};
