(function () {
  // ============================================================================================
  // POINCARÉLAB — visualizador interativo do plano hiperbólico no disco de Poincaré.
  //
  // Convenção de coordenadas usada em todo o arquivo:
  //   • "px/py" ou variáveis em maiúscula sem prefixo (A, B, P...) — coordenadas de PIXEL na
  //     tela (sistema do <svg>, origem no canto superior esquerdo, ver SIZE/CX/CY abaixo).
  //   • "uX/uY" ou variáveis prefixadas com "u" (uA, uB, uP...) — coordenadas no DISCO UNITÁRIO
  //     (centro do disco na origem, raio 1), o sistema em que toda a matemática hiperbólica
  //     (distâncias, tangentes, círculos ortogonais) é definida e calculada.
  //   toUnitDisk()/fromUnitDisk() convertem entre os dois sistemas; um objeto "geom" descreve uma
  //   h-reta já nesse sistema unitário, como {type:'diameter', dirx, diry} ou
  //   {type:'arc', cxu, cyu, ru} (centro/raio do círculo ortogonal à borda que a define).
  //
  // Seções deste arquivo, em ordem:
  //   1. Estado global e histórico (undo/redo, captura/restauração de estado)
  //   2. Nomenclatura de objetos (A, B... / a, b... / α, β... / Ω, Ω₁...)
  //   3. Geometria do disco de Poincaré (funções matemáticas puras, sem DOM)
  //   4. Renderização (desenha objetos existentes no <svg>)
  //   5. Interação do usuário (cliques, arraste, snap, ferramentas)
  //   6. Painel de propriedades (cor, espessura, visibilidade)
  //   7. Zoom
  //   8. Sistema de comandos de texto (parser, comandos diretos, restrições)
  // ============================================================================================

  const svg = document.getElementById('canvas');
  const hint = document.getElementById('hint');
  const algebraList = document.getElementById('algebraList');
  const SIZE = 520;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const R = 220;

  const NS = 'http://www.w3.org/2000/svg';

  let tool = 'point';
  let points = [];
  let lines = [];
  let segments = [];
  let angles = [];
  let pointCounter = 0;
  let idealCounter = 0;
  let lineSegCounter = 0;
  let angleCounter = 0;
  let pending = [];
  let snapTarget = null;
  let draggingPointId = null;
  let draggingSnapGeom = null;
  let draggingAngleLabelId = null;
  let draggingLineSegLabelId = null;
  let draggingPointLabelId = null;

  // --- estado serializável, undo/redo e import/export ---
  // captura tudo que define a construção: os objetos e os contadores de nomenclatura
  // (para que desfazer/refazer e reimportar preservem a sequência de nomes corretamente).
  function captureState() {
    return {
      points: JSON.parse(JSON.stringify(points)),
      lines: JSON.parse(JSON.stringify(lines)),
      segments: JSON.parse(JSON.stringify(segments)),
      angles: JSON.parse(JSON.stringify(angles)),
      pointCounter, lineSegCounter, angleCounter
    };
  }

  function restoreState(state) {
    points = JSON.parse(JSON.stringify(state.points || []));
    lines = JSON.parse(JSON.stringify(state.lines || []));
    segments = JSON.parse(JSON.stringify(state.segments || []));
    angles = JSON.parse(JSON.stringify(state.angles || []));
    pointCounter = state.pointCounter || 0;
    lineSegCounter = state.lineSegCounter || 0;
    angleCounter = state.angleCounter || 0;
    pending = [];
    snapTarget = null;
  }

  const undoStack = [];
  const redoStack = [];
  const HISTORY_LIMIT = 100;

  // chamado sempre que uma ação MUTA a construção (criar/mover/apagar objeto, mudar
  // propriedade), ANTES da mutação ser aplicada — empilha o estado anterior para desfazer.
  function pushHistory() {
    undoStack.push(captureState());
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0; // qualquer nova ação invalida o "refazer" pendente
    if (typeof refreshHistoryButtons === 'function') refreshHistoryButtons();
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(captureState());
    const prev = undoStack.pop();
    restoreState(prev);
    render();
    hint.textContent = 'Ação desfeita.';
    if (typeof refreshHistoryButtons === 'function') refreshHistoryButtons();
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(captureState());
    const next = redoStack.pop();
    restoreState(next);
    render();
    hint.textContent = 'Ação refeita.';
    if (typeof refreshHistoryButtons === 'function') refreshHistoryButtons();
  }

  // ===== 2. NOMENCLATURA DE OBJETOS =============================================================
  // Cada tipo de objeto tem sua própria sequência de nomes (à la GeoGebra): pontos comuns em
  // maiúsculas (A, B, C...), retas/segmentos em minúsculas (a, b, c...), ângulos em letras
  // gregas (α, β, γ...), pontos ideais com Ω. Os quatro contadores (pointCounter, idealCounter,
  // lineSegCounter, angleCounter) avançam independentemente.

  function letterFor(i) {
    return String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
  }

  // nomenclatura de pontos ideais: Ω, Ω₁, Ω₂... (sequência própria, fora do alfabeto de pontos comuns)
  const SUBSCRIPT_DIGITS = ['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉'];
  function subscriptFor(n) {
    return String(n).split('').map(d => SUBSCRIPT_DIGITS[+d]).join('');
  }
  function nextIdealLabel() {
    const label = idealCounter === 0 ? 'Ω' : 'Ω' + subscriptFor(idealCounter);
    idealCounter++;
    return label;
  }

  // nomenclatura de retas/segmentos: letras minúsculas a, b, c... (compartilhada entre os dois tipos,
  // como no GeoGebra, onde o índice reflete a ordem de criação, não o tipo).
  function lowerLetterFor(i) {
    return String.fromCharCode(97 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
  }

  // nomenclatura de ângulos: letras gregas minúsculas α, β, γ...
  const GREEK_LETTERS = ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ', 'ν', 'ξ', 'ο', 'π', 'ρ', 'σ', 'τ', 'υ', 'φ', 'χ', 'ψ', 'ω'];
  function greekLetterFor(i) {
    return GREEK_LETTERS[i % GREEK_LETTERS.length] + (i >= GREEK_LETTERS.length ? Math.floor(i / GREEK_LETTERS.length) : '');
  }

  function nextLineSegLabel() {
    const label = lowerLetterFor(lineSegCounter);
    lineSegCounter++;
    return label;
  }

  function nextAngleLabel() {
    const label = greekLetterFor(angleCounter);
    angleCounter++;
    return label;
  }

  // ===== 3. GEOMETRIA DO DISCO DE POINCARÉ =======================================================
  // Funções matemáticas puras (sem tocar no DOM): conversão de coordenadas, construção de h-retas
  // como diâmetros ou arcos ortogonais à borda, tangentes, distância hiperbólica, e as construções
  // derivadas (ponto médio, pé da perpendicular, reflexão, ponto a distância/direção fixas).
  // Toda essa camada foi validada numericamente contra reimplementações independentes antes de
  // entrar no app — ver o histórico de testes da conversa para os casos de referência.

  function dist(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
  }

  function toUnitDisk(px, py) {
    return { x: (px - CX) / R, y: (py - CY) / R };
  }

  function fromUnitDisk(ux, uy) {
    return { x: CX + ux * R, y: CY + uy * R };
  }

  function drawBase() {
    svg.innerHTML = '';
    const bg = document.createElementNS(NS, 'circle');
    bg.setAttribute('cx', CX);
    bg.setAttribute('cy', CY);
    bg.setAttribute('r', R);
    bg.setAttribute('fill', 'var(--disk-fill)');
    bg.setAttribute('stroke', 'var(--disk-edge)');
    bg.setAttribute('stroke-width', '1.6');
    svg.appendChild(bg);
  }

  function unitCircleThrough(u1, u2) {
    const eps = 1e-6;
    const cross = u1.x * u2.y - u1.y * u2.x;
    if (Math.abs(cross) < eps) return null;

    const d1 = u1.x * u1.x + u1.y * u1.y;
    const d2 = u2.x * u2.x + u2.y * u2.y;
    const a = 1 + d1;
    const b = 1 + d2;

    const cx = (a * u2.y - b * u1.y) / (2 * cross);
    const cy = (b * u1.x - a * u2.x) / (2 * cross);
    const r = Math.sqrt(cx * cx + cy * cy - 1);
    return { cx, cy, r };
  }

  function buildHLineGeom(u1, u2) {
    const eps = 1e-6;
    const cross = Math.abs(u1.x * u2.y - u1.y * u2.x);

    if (cross < eps) {
      const ddx = u2.x - u1.x;
      const ddy = u2.y - u1.y;
      const norm = Math.hypot(ddx, ddy) || 1;
      const dx = ddx / norm;
      const dy = ddy / norm;
      return { type: 'diameter', dirx: dx, diry: dy };
    }

    const circ = unitCircleThrough(u1, u2);
    if (!circ) return null;
    return { type: 'arc', cxu: circ.cx, cyu: circ.cy, ru: circ.r };
  }

  function circleDiskIntersections(cxu, cyu, ru) {
    const d = Math.hypot(cxu, cyu);
    const a = (1 - ru * ru + d * d) / (2 * d);
    const h2 = 1 - a * a;
    if (h2 < 0) return [];
    const h = Math.sqrt(h2);
    const ux = cxu / d;
    const uy = cyu / d;
    const midx = a * ux;
    const midy = a * uy;
    return [
      { x: midx + h * (-uy), y: midy + h * ux },
      { x: midx - h * (-uy), y: midy - h * ux }
    ];
  }

  function arcPathBetween(geom, uA, uB, extendToBoundary) {
    if (geom.type === 'diameter') {
      let pA = uA, pB = uB;
      if (extendToBoundary) {
        pA = { x: geom.dirx, y: geom.diry };
        pB = { x: -geom.dirx, y: -geom.diry };
      }
      const e1 = fromUnitDisk(pA.x, pA.y);
      const e2 = fromUnitDisk(pB.x, pB.y);
      return { d: 'M ' + e1.x + ' ' + e1.y + ' L ' + e2.x + ' ' + e2.y };
    }

    const centerPx = fromUnitDisk(geom.cxu, geom.cyu);
    const rPx = geom.ru * R;

    let pA, pB;
    if (extendToBoundary) {
      const ends = circleDiskIntersections(geom.cxu, geom.cyu, geom.ru);
      if (ends.length < 2) return null;
      pA = ends[0];
      pB = ends[1];
    } else {
      pA = uA;
      pB = uB;
    }

    const e1 = fromUnitDisk(pA.x, pA.y);
    const e2 = fromUnitDisk(pB.x, pB.y);

    const a1 = Math.atan2(e1.y - centerPx.y, e1.x - centerPx.x);
    const a2 = Math.atan2(e2.y - centerPx.y, e2.x - centerPx.x);
    let delta = a2 - a1;
    while (delta <= -Math.PI) delta += 2 * Math.PI;
    while (delta > Math.PI) delta -= 2 * Math.PI;

    let largeArc, sweep;
    if (extendToBoundary) {
      largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
      sweep = delta > 0 ? 1 : 0;
    } else {
      largeArc = 0;
      sweep = delta > 0 ? 1 : 0;
    }

    return { d: 'M ' + e1.x + ' ' + e1.y + ' A ' + rPx + ' ' + rPx + ' 0 ' + largeArc + ' ' + sweep + ' ' + e2.x + ' ' + e2.y };
  }

  function tangentAt(geom, uP) {
    if (geom.type === 'diameter') {
      const n = Math.hypot(geom.dirx, geom.diry) || 1;
      return { x: geom.dirx / n, y: geom.diry / n };
    }
    const rx = uP.x - geom.cxu;
    const ry = uP.y - geom.cyu;
    const tx = -ry;
    const ty = rx;
    const n = Math.hypot(tx, ty) || 1;
    return { x: tx / n, y: ty / n };
  }

  // orienta um vetor tangente para apontar no mesmo sentido geral de "toward" (produto escalar
  // não-negativo). Uma tangente pode apontar em qualquer uma das duas direções da curva; isto
  // resolve a ambiguidade escolhendo a que se afasta do vértice em direção ao ponto de referência.
  function orientTangent(tangent, toward) {
    const dot = tangent.x * toward.x + tangent.y * toward.y;
    return dot >= 0 ? tangent : { x: -tangent.x, y: -tangent.y };
  }

  // mede o ângulo hiperbólico (em graus, 0–180) no vértice V, entre os dois lados V→A e V→B,
  // usando o critério do modelo de Poincaré: o ângulo entre duas h-retas coincide com o ângulo
  // euclidiano entre suas tangentes no ponto de encontro (o modelo é conforme). Ponto central
  // usado tanto para desenhar h-ângulos (renderAngleArc) quanto para resolver restrições
  // (solveConstraintOnCurve, solveConstraintByDirection) — mantém as duas coisas consistentes
  // por construção. Retorna null se V coincidir com A ou B (h-reta degenerada).
  function measureAngle(V, A, B) {
    const geomVA = buildHLineGeom(V, A);
    const geomVB = buildHLineGeom(V, B);
    if (!geomVA || !geomVB) return null;

    const dirA = orientTangent(tangentAt(geomVA, V), { x: A.x - V.x, y: A.y - V.y });
    const dirB = orientTangent(tangentAt(geomVB, V), { x: B.x - V.x, y: B.y - V.y });

    const angA = Math.atan2(dirA.y, dirA.x);
    const angB = Math.atan2(dirB.y, dirB.x);
    let deltaDeg = ((angB - angA) * 180 / Math.PI) % 360;
    if (deltaDeg < 0) deltaDeg += 360;
    const measureDeg = deltaDeg > 180 ? 360 - deltaDeg : deltaDeg;

    return { measureDeg, dirA, dirB };
  }

  // projeta um ponto p (coords do disco unitário) sobre a curva geom (diâmetro ou arco),
  // retornando o ponto mais próximo pertencente à curva.
  function projectToGeom(geom, p) {
    if (geom.type === 'diameter') {
      const t = p.x * geom.dirx + p.y * geom.diry;
      return { x: t * geom.dirx, y: t * geom.diry };
    }
    const vx = p.x - geom.cxu;
    const vy = p.y - geom.cyu;
    const d = Math.hypot(vx, vy) || 1;
    return { x: geom.cxu + (vx / d) * geom.ru, y: geom.cyu + (vy / d) * geom.ru };
  }

  // clamp de um ponto projetado para dentro do trecho [uA,uB] de um segmento (não da reta inteira).
  // usado só para snap em h-segmentos, onde a curva "útil" é limitada aos dois extremos.
  function clampToSegmentArc(geom, uA, uB, projected) {
    if (geom.type === 'diameter') {
      const tA = uA.x * geom.dirx + uA.y * geom.diry;
      const tB = uB.x * geom.dirx + uB.y * geom.diry;
      const tP = projected.x * geom.dirx + projected.y * geom.diry;
      const lo = Math.min(tA, tB), hi = Math.max(tA, tB);
      const tClamped = Math.max(lo, Math.min(hi, tP));
      return { x: tClamped * geom.dirx, y: tClamped * geom.diry };
    }
    const angOf = (u) => Math.atan2(u.y - geom.cyu, u.x - geom.cxu);
    const aA = angOf(uA), aB = angOf(uB), aP = angOf(projected);
    let spanAB = aB - aA;
    while (spanAB <= -Math.PI) spanAB += 2 * Math.PI;
    while (spanAB > Math.PI) spanAB -= 2 * Math.PI;
    let spanAP = aP - aA;
    while (spanAP <= -Math.PI) spanAP += 2 * Math.PI;
    while (spanAP > Math.PI) spanAP -= 2 * Math.PI;
    const tRel = spanAB !== 0 ? spanAP / spanAB : 0;
    const tClamped = Math.max(0, Math.min(1, tRel));
    const aClamped = aA + tClamped * spanAB;
    return { x: geom.cxu + Math.cos(aClamped) * geom.ru, y: geom.cyu + Math.sin(aClamped) * geom.ru };
  }

  function distUnit(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // --- distância hiperbólica e construções derivadas (ponto médio, pé da perpendicular, reflexão) ---

  // distância hiperbólica via razão cruzada com os pontos ideais da geodésica, exatamente como
  // definida em Agustini (2022), Cap. 4.2: d(A,B) = ln( (AB'·BA') / (AA'·BB') ), onde A' e B' são
  // os pontos ideais (na fronteira do disco) da h-reta que contém A e B — A' do lado de A,
  // B' do lado de B. Equivalente à forma arcosh mais comum na literatura internacional
  // (verificado numericamente); esta é a forma que consta na bibliografia usada no relatório.
  function hypDist(u, v) {
    if (dist(u.x, u.y, v.x, v.y) < 1e-12) return 0; // A = B

    const geom = buildHLineGeom(u, v);
    if (!geom) return 0; // caso degenerado (não deveria ocorrer com u != v)

    let idealNeg, idealPos; // "antes de A" (A') e "depois de B" (B'), na ordem ao longo da geodésica
    if (geom.type === 'diameter') {
      idealPos = { x: geom.dirx, y: geom.diry };
      idealNeg = { x: -geom.dirx, y: -geom.diry };
    } else {
      const ends = circleDiskIntersections(geom.cxu, geom.cyu, geom.ru);
      if (ends.length < 2) return 0;
      const angOf = (p) => Math.atan2(p.y - geom.cyu, p.x - geom.cxu);
      const aU = angOf(u), aV = angOf(v);
      let span = aV - aU;
      while (span <= -Math.PI) span += 2 * Math.PI;
      while (span > Math.PI) span -= 2 * Math.PI;
      let d0 = angOf(ends[0]) - aU;
      while (d0 <= -Math.PI) d0 += 2 * Math.PI;
      while (d0 > Math.PI) d0 -= 2 * Math.PI;
      if ((d0 > 0) === (span > 0)) {
        idealPos = ends[0]; idealNeg = ends[1];
      } else {
        idealPos = ends[1]; idealNeg = ends[0];
      }
    }

    const Aprime = idealNeg, Bprime = idealPos;
    const AB_prime = dist(u.x, u.y, Bprime.x, Bprime.y);
    const BA_prime = dist(v.x, v.y, Aprime.x, Aprime.y);
    const AA_prime = dist(u.x, u.y, Aprime.x, Aprime.y);
    const BB_prime = dist(v.x, v.y, Bprime.x, Bprime.y);

    const ratio = (AB_prime * BA_prime) / Math.max(AA_prime * BB_prime, 1e-12);
    return Math.log(Math.max(ratio, 1));
  }

  // dado um ponto A no disco unitário, uma direção (ângulo em radianos) e uma distância
  // HIPERBÓLICA alvo, retorna o ponto B nessa direção a exatamente essa distância de A.
  // Usa a isometria de Möbius que leva A à origem (onde a fórmula radial é simples:
  // dist(0,r) = 2·artanh(r), logo r = tanh(dist/2)), resolve ali, e desfaz a transformação.
  function pointAtHyperbolicDirection(A, directionRad, targetDist) {
    // números complexos manuais (sem depender de biblioteca): z = {re, im}
    const toOrigin = (zx, zy) => {
      // f(z) = (z - A) / (1 - conj(A)*z)
      const numRe = zx - A.x, numIm = zy - A.y;
      const denRe = 1 - (A.x * zx + A.y * zy), denIm = -(A.x * zy - A.y * zx);
      const denNorm = denRe * denRe + denIm * denIm || 1e-12;
      return {
        x: (numRe * denRe + numIm * denIm) / denNorm,
        y: (numIm * denRe - numRe * denIm) / denNorm
      };
    };
    const fromOrigin = (wx, wy) => {
      // f^-1(w) = (w + A) / (1 + conj(A)*w)
      const numRe = wx + A.x, numIm = wy + A.y;
      const denRe = 1 + (A.x * wx + A.y * wy), denIm = (A.x * wy - A.y * wx);
      const denNorm = denRe * denRe + denIm * denIm || 1e-12;
      return {
        x: (numRe * denRe + numIm * denIm) / denNorm,
        y: (numIm * denRe - numRe * denIm) / denNorm
      };
    };
    const r = Math.tanh(targetDist / 2);
    const wx = r * Math.cos(directionRad);
    const wy = r * Math.sin(directionRad);
    return fromOrigin(wx, wy);
  }

  // ponto sobre a curva geom, parametrizado de uA (t=0) a uB (t=1)
  function pointAtParam(geom, uA, uB, t) {
    if (geom.type === 'diameter') {
      return { x: uA.x + t * (uB.x - uA.x), y: uA.y + t * (uB.y - uA.y) };
    }
    const angOf = (u) => Math.atan2(u.y - geom.cyu, u.x - geom.cxu);
    const aA = angOf(uA), aB = angOf(uB);
    let span = aB - aA;
    while (span <= -Math.PI) span += 2 * Math.PI;
    while (span > Math.PI) span -= 2 * Math.PI;
    const a = aA + t * span;
    return { x: geom.cxu + Math.cos(a) * geom.ru, y: geom.cyu + Math.sin(a) * geom.ru };
  }

  // ponto médio hiperbólico real (equidistante na métrica do disco), por busca binária ao longo da curva
  function hyperbolicMidpoint(uA, uB) {
    const geom = buildHLineGeom(uA, uB);
    if (!geom) return null;
    const dTotal = hypDist(uA, uB);
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const p = pointAtParam(geom, uA, uB, mid);
      if (hypDist(uA, p) < dTotal / 2) lo = mid; else hi = mid;
    }
    return pointAtParam(geom, uA, uB, (lo + hi) / 2);
  }

  // pé da perpendicular de P a uma h-reta/h-segmento (uA,uB): ponto Q na curva cuja tangente é
  // ortogonal à direção Q->P. Busca a raiz do produto escalar tangente·direção ao longo do parâmetro t.
  function footOfPerpendicular(uA, uB, uP) {
    const geom = buildHLineGeom(uA, uB);
    if (!geom) return null;

    // Para cada candidato Q na curva base, o critério correto de perpendicularidade hiperbólica
    // é comparar a tangente da curva base em Q com a tangente da H-RETA (curva) que liga Q a P —
    // não com a direção em linha reta euclidiana entre Q e P, que só coincide com a tangente da
    // h-reta quando Q está muito perto do centro do disco (caso contrário introduz erro sistemático).
    function dotAt(t) {
      const Q = pointAtParam(geom, uA, uB, t);
      const tangBase = tangentAt(geom, Q);
      const geomQP = buildHLineGeom(Q, uP);
      if (!geomQP) return 0; // Q, P e a origem colineares (caso degenerado raro)
      const tangQP = tangentAt(geomQP, Q);
      return tangBase.x * tangQP.x + tangBase.y * tangQP.y;
    }

    const N = 400;
    let prevT = -0.5;
    let prevVal = dotAt(prevT);
    let rootT = null;
    for (let i = 1; i <= N; i++) {
      const t = -0.5 + i * (2.0 / N);
      const val = dotAt(t);
      if (prevVal * val < 0) {
        let lo = prevT, hi = t;
        for (let k = 0; k < 60; k++) {
          const mid = (lo + hi) / 2;
          if (dotAt(lo) * dotAt(mid) <= 0) hi = mid; else lo = mid;
        }
        rootT = (lo + hi) / 2;
        break;
      }
      prevT = t;
      prevVal = val;
    }
    if (rootT === null) return null;
    return pointAtParam(geom, uA, uB, rootT);
  }

  // reflexão hiperbólica de um ponto através de uma h-reta: reflexão euclidiana comum se a h-reta
  // é um diâmetro; inversão no círculo-suporte se é um arco (isometria do modelo de Poincaré).
  function reflectPoint(uA, uB, uP) {
    const geom = buildHLineGeom(uA, uB);
    if (!geom) return null;

    if (geom.type === 'diameter') {
      const t = uP.x * geom.dirx + uP.y * geom.diry;
      const proj = { x: t * geom.dirx, y: t * geom.diry };
      return { x: 2 * proj.x - uP.x, y: 2 * proj.y - uP.y };
    }

    const vx = uP.x - geom.cxu;
    const vy = uP.y - geom.cyu;
    const d2 = vx * vx + vy * vy;
    if (d2 < 1e-12) return null;
    const k = (geom.ru * geom.ru) / d2;
    return { x: geom.cxu + vx * k, y: geom.cyu + vy * k };
  }

  // encontra o objeto (h-reta ou h-segmento) mais próximo de um ponto do cursor (coords de pixel),
  // dentro de uma tolerância. Retorna {kind, obj, snappedPointPx} ou null.
  const SNAP_TOL_PX = 10;

  function findSnapTarget(px, py) {
    const uCursor = toUnitDisk(px, py);
    let best = null;
    let bestDistPx = SNAP_TOL_PX;
    const MAX_NORM = 0.95; // margem de segurança: nunca gruda pontos rente à fronteira do disco

    lines.forEach(line => {
      const uA = toUnitDisk(line.p1.x, line.p1.y);
      const uB = toUnitDisk(line.p2.x, line.p2.y);
      const geom = buildHLineGeom(uA, uB);
      if (!geom) return;
      const proj = projectToGeom(geom, uCursor);
      if (Math.hypot(proj.x, proj.y) >= MAX_NORM) return;
      const projPx = fromUnitDisk(proj.x, proj.y);
      const dPx = dist(px, py, projPx.x, projPx.y);
      if (dPx < bestDistPx) {
        bestDistPx = dPx;
        best = { kind: 'hline', obj: line, geom, uA, uB, snapped: proj, snappedPx: projPx };
      }
    });

    segments.forEach(seg => {
      const uA = toUnitDisk(seg.p1.x, seg.p1.y);
      const uB = toUnitDisk(seg.p2.x, seg.p2.y);
      const geom = buildHLineGeom(uA, uB);
      if (!geom) return;
      const rawProj = projectToGeom(geom, uCursor);
      const proj = clampToSegmentArc(geom, uA, uB, rawProj);
      if (Math.hypot(proj.x, proj.y) >= MAX_NORM) return;
      const projPx = fromUnitDisk(proj.x, proj.y);
      const dPx = dist(px, py, projPx.x, projPx.y);
      if (dPx < bestDistPx) {
        bestDistPx = dPx;
        best = { kind: 'hsegment', obj: seg, geom, uA, uB, snapped: proj, snappedPx: projPx };
      }
    });

    return best;
  }

  // converte um estilo de traço nomeado em stroke-dasharray, escalado pela espessura
  // (traços proporcionalmente maiores em linhas mais grossas continuam legíveis).
  // ===== 4. RENDERIZAÇÃO =========================================================================
  // Desenha o estado atual (points/lines/segments/angles) como elementos SVG. render() é a função
  // que orquestra tudo — chamada depois de qualquer mutação de estado — e delega a cada tipo de
  // objeto sua própria função de desenho (renderPoint, renderCurve+renderLineSegLabel, renderAngleArc).

  function dashArrayFor(dashStyle, strokeWidth) {
    if (dashStyle === 'dashed') return (strokeWidth * 3.2) + ' ' + (strokeWidth * 2.2);
    if (dashStyle === 'dotted') return '0.1 ' + (strokeWidth * 2.4);
    return null;
  }

  function renderCurve(geom, uA, uB, colorVar, extraClass, idAttr, obj) {
    const built = arcPathBetween(geom, uA, uB, extraClass === 'hline');
    if (!built) return null;
    const isSnapTarget = snapTarget && snapTarget.obj.id === idAttr;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', built.d);
    const strokeColor = isSnapTarget ? 'var(--accent)' : (obj && obj.customColor ? obj.customColor : colorVar);
    const strokeWidth = isSnapTarget ? 3.4 : (obj && obj.customWidth ? obj.customWidth : (extraClass === 'hline' ? 1.8 : 2.6));
    path.setAttribute('stroke', strokeColor);
    path.setAttribute('stroke-width', strokeWidth);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    const dashStyle = obj && obj.dashStyle;
    const dashArray = dashArrayFor(dashStyle, strokeWidth);
    if (dashArray) path.setAttribute('stroke-dasharray', dashArray);
    if (extraClass === 'hline' && !isSnapTarget) path.setAttribute('opacity', '0.85');
    if (idAttr) path.dataset.objId = idAttr;
    svg.appendChild(path);
    return path;
  }

  // rótulo (nome) de uma h-reta ou h-segmento, posicionado por padrão no ponto médio visual da
  // curva, mas arrastável livremente (offset salvo no próprio objeto, como no rótulo de ângulo).
  function renderLineSegLabel(obj, geom, uA, uB, colorVar, isSegment, ptA, ptB) {
    if (obj.labelVisible === false) return;
    const mid = pointAtParam(geom, uA, uB, 0.5);
    const midPx = fromUnitDisk(mid.x, mid.y);
    if (!obj.labelOffset) obj.labelOffset = { x: 10, y: -8 };
    const lx = midPx.x + obj.labelOffset.x;
    const ly = midPx.y + obj.labelOffset.y;

    let text = obj.label || '?';
    // comprimento hiperbólico só faz sentido entre dois pontos finitos (não pontos ideais,
    // cuja distância a qualquer ponto do disco tende a infinito) e só para h-segmentos.
    if (isSegment && obj.showValue === true && ptA && ptB && !ptA.isIdeal && !ptB.isIdeal) {
      const length = hypDist(uA, uB);
      text += ' = ' + length.toFixed(2);
    }

    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', lx);
    t.setAttribute('y', ly);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'label-text');
    t.setAttribute('font-size', '14');
    t.setAttribute('fill', obj.customColor || colorVar);
    t.style.cursor = 'move';
    t.style.pointerEvents = 'auto';
    t.textContent = text;
    t.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      draggingLineSegLabelId = obj.id;
    });
    t.addEventListener('click', (ev) => ev.stopPropagation());
    svg.appendChild(t);

    obj._baseLabelPos = { x: midPx.x, y: midPx.y };
  }

  function renderSnapMarker() {
    if (!snapTarget) return;
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', snapTarget.snappedPx.x);
    c.setAttribute('cy', snapTarget.snappedPx.y);
    c.setAttribute('r', 5.5);
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', 'var(--accent)');
    c.setAttribute('stroke-width', '1.6');
    c.setAttribute('pointer-events', 'none');
    svg.appendChild(c);
  }

  function renderPoint(pt) {
    if (pt.visible === false) return;
    const isPending = pending.some(p => p.id === pt.id);
    const g = document.createElementNS(NS, 'g');
    g.dataset.pointId = pt.id;

    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', pt.x);
    c.setAttribute('cy', pt.y);
    if (pt.isIdeal) {
      // ponto ideal: marcador vazado (só contorno), convenção usual para "ponto no infinito"
      c.setAttribute('r', isPending ? 6 : 4.6);
      c.setAttribute('fill', 'var(--paper)');
      c.setAttribute('stroke', isPending ? 'var(--accent-soft)' : (pt.customColor || 'var(--point)'));
      c.setAttribute('stroke-width', '1.8');
    } else {
      c.setAttribute('r', isPending ? 6 : 4.2);
      c.setAttribute('fill', isPending ? 'var(--accent-soft)' : (pt.customColor || 'var(--point)'));
      c.setAttribute('stroke', 'var(--paper)');
      c.setAttribute('stroke-width', '1.4');
    }
    g.appendChild(c);

    if (pt.labelVisible !== false) {
      if (!pt.labelOffset) pt.labelOffset = { x: 9, y: -8 };
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', pt.x + pt.labelOffset.x);
      t.setAttribute('y', pt.y + pt.labelOffset.y);
      t.setAttribute('class', 'label-text');
      t.setAttribute('fill', pt.customColor || 'var(--ink)');
      t.textContent = pt.label;
      t.style.cursor = 'move';
      t.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        draggingPointLabelId = pt.id;
      });
      t.addEventListener('click', (ev) => ev.stopPropagation());
      g.appendChild(t);
    }

    g.style.cursor = tool === 'move' ? 'grab' : 'pointer';
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (tool === 'move') return;
      handlePointClick(pt);
    });
    g.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      openPropPanel(pt, 'Ponto', ev);
    });
    g.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openPropPanel(pt, 'Ponto', ev);
    });

    if (tool === 'move') {
      g.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        pushHistory();
        draggingPointId = pt.id;
        draggingSnapGeom = findObjectContainingPoint(pt);
        hint.textContent = draggingSnapGeom
          ? 'Movendo ' + pt.label + ' (preso à curva original).'
          : 'Movendo ' + pt.label + '.';
      });
    }

    svg.appendChild(g);
  }

  // verifica se um ponto está (aproximadamente) sobre alguma h-reta ou h-segmento existente,
  // para que, ao ser arrastado, continue restrito a essa curva.
  function findObjectContainingPoint(pt) {
    const uP = toUnitDisk(pt.x, pt.y);
    const TOL = 0.01;

    for (const line of lines) {
      const uA = toUnitDisk(line.p1.x, line.p1.y);
      const uB = toUnitDisk(line.p2.x, line.p2.y);
      const geom = buildHLineGeom(uA, uB);
      if (!geom) continue;
      const proj = projectToGeom(geom, uP);
      if (distUnit(proj, uP) < TOL) {
        return { kind: 'hline', geom, uA, uB };
      }
    }
    for (const seg of segments) {
      const uA = toUnitDisk(seg.p1.x, seg.p1.y);
      const uB = toUnitDisk(seg.p2.x, seg.p2.y);
      const geom = buildHLineGeom(uA, uB);
      if (!geom) continue;
      const rawProj = projectToGeom(geom, uP);
      const proj = clampToSegmentArc(geom, uA, uB, rawProj);
      if (distUnit(proj, uP) < TOL) {
        return { kind: 'hsegment', geom, uA, uB };
      }
    }
    return null;
  }

  function renderAngleArc(ang) {
    if (ang.visible === false) return;
    const V = points.find(p => p.id === ang.vId);
    const A = points.find(p => p.id === ang.aId);
    const B = points.find(p => p.id === ang.bId);
    if (!V || !A || !B) return;

    const uV = toUnitDisk(V.x, V.y);
    const uA = toUnitDisk(A.x, A.y);
    const uB = toUnitDisk(B.x, B.y);

    const measured = measureAngle(uV, uA, uB);
    if (!measured) return;
    const { measureDeg, dirA, dirB } = measured;

    const angA = Math.atan2(dirA.y, dirA.x);
    const angB = Math.atan2(dirB.y, dirB.x);

    const rad = 22;
    const vPx = fromUnitDisk(uV.x, uV.y);
    const p1 = { x: vPx.x + dirA.x * rad, y: vPx.y + dirA.y * rad };
    const p2 = { x: vPx.x + dirB.x * rad, y: vPx.y + dirB.y * rad };

    let delta2 = angB - angA;
    while (delta2 <= -Math.PI) delta2 += 2 * Math.PI;
    while (delta2 > Math.PI) delta2 -= 2 * Math.PI;
    const sweep = delta2 > 0 ? 1 : 0;
    const largeArc = Math.abs(delta2) > Math.PI ? 1 : 0;

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M ' + p1.x + ' ' + p1.y + ' A ' + rad + ' ' + rad + ' 0 ' + largeArc + ' ' + sweep + ' ' + p2.x + ' ' + p2.y);
    path.setAttribute('stroke', ang.customColor || 'var(--hang)');
    path.setAttribute('stroke-width', ang.customWidth || 1.8);
    path.setAttribute('fill', 'none');
    const angDashArray = dashArrayFor(ang.dashStyle, ang.customWidth || 1.8);
    if (angDashArray) path.setAttribute('stroke-dasharray', angDashArray);
    path.dataset.objId = ang.id;
    path.style.cursor = 'context-menu';
    path.style.pointerEvents = 'stroke';
    path.addEventListener('click', (ev) => ev.stopPropagation());
    path.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      openPropPanel(ang, 'H-ângulo', ev);
    });
    path.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openPropPanel(ang, 'H-ângulo', ev);
    });
    svg.appendChild(path);

    const midAngle = angA + delta2 / 2;
    const labelR = rad + 15;
    const baseLx = vPx.x + Math.cos(midAngle) * labelR;
    const baseLy = vPx.y + Math.sin(midAngle) * labelR;
    if (!ang.labelOffset) ang.labelOffset = { x: 0, y: 0 };
    const lx = baseLx + ang.labelOffset.x;
    const ly = baseLy + ang.labelOffset.y;

    ang.measureDeg = measureDeg;
    ang._baseLabelPos = { x: baseLx, y: baseLy };

    if (ang.labelVisible === false) return;

    const showName = true; // o nome do ângulo (α, β...) sempre acompanha o rótulo quando visível
    const showValue = ang.showValue !== false;
    let text = '';
    if (showName) text += (ang.label || '?');
    if (showValue) text += (showName ? ' = ' : '') + measureDeg.toFixed(1) + '°';
    if (!text) return;

    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', lx);
    t.setAttribute('y', ly);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'label-text');
    t.setAttribute('font-size', '12.5');
    t.setAttribute('fill', ang.customColor || 'var(--hang)');
    t.style.fontStyle = 'normal';
    t.style.cursor = 'move';
    t.style.pointerEvents = 'auto';
    t.textContent = text;
    t.dataset.angleLabelId = ang.id;
    t.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      draggingAngleLabelId = ang.id;
    });
    t.addEventListener('click', (ev) => ev.stopPropagation());
    svg.appendChild(t);
  }

  function render() {
    drawBase();

    lines.forEach(line => {
      if (line.visible === false) return;
      const uA = toUnitDisk(line.p1.x, line.p1.y);
      const uB = toUnitDisk(line.p2.x, line.p2.y);
      const geom = buildHLineGeom(uA, uB);
      if (!geom) return;
      const path = renderCurve(geom, uA, uB, 'var(--hreta)', 'hline', line.id, line);
      if (path && tool === 'delete') {
        path.style.cursor = 'pointer';
        path.addEventListener('click', (ev) => {
          ev.stopPropagation();
          pushHistory();
          lines = lines.filter(l => l.id !== line.id);
          render();
        });
      } else if (path) {
        // deixa o clique único vazar para o svg quando a ferramenta ativa pode usá-lo
        // (criar/usar um ponto sobre esta h-reta, via snap); bloqueia quando não há ação de
        // ferramenta aplicável, e também quando o clique faz parte de um duplo-clique
        // (ev.detail >= 2), para não criar pontos indesejados enquanto o painel abre.
        path.addEventListener('click', (ev) => {
          const isPartOfDblClick = ev.detail >= 2;
          if (isPartOfDblClick || (tool !== 'point' && !CONSTRUCTION_TOOLS.includes(tool))) {
            ev.stopPropagation();
          }
        });
      }
      if (path) {
        path.style.cursor = tool === 'delete' ? 'pointer' : 'context-menu';
        path.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          openPropPanel(line, 'H-reta', ev);
        });
        path.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openPropPanel(line, 'H-reta', ev);
        });
      }
      renderLineSegLabel(line, geom, uA, uB, 'var(--hreta)');
    });

    segments.forEach(seg => {
      if (seg.visible === false) return;
      const uA = toUnitDisk(seg.p1.x, seg.p1.y);
      const uB = toUnitDisk(seg.p2.x, seg.p2.y);
      const geom = buildHLineGeom(uA, uB);
      if (!geom) return;
      const path = renderCurve(geom, uA, uB, 'var(--hseg)', 'hsegment', seg.id, seg);
      if (path && tool === 'delete') {
        path.style.cursor = 'pointer';
        path.addEventListener('click', (ev) => {
          ev.stopPropagation();
          pushHistory();
          segments = segments.filter(s => s.id !== seg.id);
          render();
        });
      } else if (path) {
        path.addEventListener('click', (ev) => {
          const isPartOfDblClick = ev.detail >= 2;
          if (isPartOfDblClick || (tool !== 'point' && !CONSTRUCTION_TOOLS.includes(tool))) {
            ev.stopPropagation();
          }
        });
      }
      if (path) {
        if (tool !== 'delete') path.style.cursor = 'context-menu';
        path.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          openPropPanel(seg, 'H-segmento', ev);
        });
        path.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openPropPanel(seg, 'H-segmento', ev);
        });
      }
      const ptA = points.find(p => dist(p.x, p.y, seg.p1.x, seg.p1.y) < 0.01);
      const ptB = points.find(p => dist(p.x, p.y, seg.p2.x, seg.p2.y) < 0.01);
      renderLineSegLabel(seg, geom, uA, uB, 'var(--hseg)', true, ptA, ptB);
    });

    angles.forEach(renderAngleArc);
    points.forEach(renderPoint);
    renderSnapMarker();
    renderAlgebra();
  }

  function renderAlgebra() {
    algebraList.innerHTML = '';
    const items = [];

    points.forEach((p) => {
      const desc = p.isIdeal ? ' = ponto ideal' : ' = ponto';
      items.push({ swatch: 'var(--point)', text: p.label + desc, onDelete: () => deletePoint(p.id) });
    });
    lines.forEach((l) => {
      const nameA = (points.find(p => dist(p.x,p.y,l.p1.x,l.p1.y) < 0.01) || {}).label || '?';
      const nameB = (points.find(p => dist(p.x,p.y,l.p2.x,l.p2.y) < 0.01) || {}).label || '?';
      items.push({ swatch: 'var(--hreta)', text: (l.label || '?') + ': reta(' + nameA + ', ' + nameB + ')', onDelete: () => { pushHistory(); lines = lines.filter(x => x.id !== l.id); render(); } });
    });
    segments.forEach((s) => {
      const nameA = (points.find(p => dist(p.x,p.y,s.p1.x,s.p1.y) < 0.01) || {}).label || '?';
      const nameB = (points.find(p => dist(p.x,p.y,s.p2.x,s.p2.y) < 0.01) || {}).label || '?';
      items.push({ swatch: 'var(--hseg)', text: (s.label || '?') + ': segmento(' + nameA + ', ' + nameB + ')', onDelete: () => { pushHistory(); segments = segments.filter(x => x.id !== s.id); render(); } });
    });
    angles.forEach((a) => {
      const nameV = (points.find(p => p.id === a.vId) || {}).label || '?';
      const nameA = (points.find(p => p.id === a.aId) || {}).label || '?';
      const nameB = (points.find(p => p.id === a.bId) || {}).label || '?';
      const measure = a.measureDeg !== undefined ? ('= ' + a.measureDeg.toFixed(1) + '°') : '';
      items.push({ swatch: 'var(--hang)', text: (a.label || '?') + ': ângulo(' + nameA + ', ' + nameV + ', ' + nameB + ') ' + measure, onDelete: () => { pushHistory(); angles = angles.filter(x => x.id !== a.id); render(); } });
    });

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'algebra-empty';
      empty.textContent = 'Nenhum objeto ainda.';
      algebraList.appendChild(empty);
      return;
    }

    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'algebra-row';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = item.swatch;
      const expr = document.createElement('span');
      expr.className = 'expr';
      expr.textContent = item.text;
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '×';
      del.title = 'Remover';
      del.addEventListener('click', item.onDelete);
      row.appendChild(sw);
      row.appendChild(expr);
      row.appendChild(del);
      algebraList.appendChild(row);
    });
  }

  // garante que existe uma h-reta ou h-segmento ligando p1 e p2; se não houver nenhum, cria
  // um objeto do tipo pedido ('hsegment' por padrão — o natural para "lado" de uma construção;
  // 'hline' quando faz mais sentido conceitual, como uma reta-espelho de reflexão).
  // ===== 5. INTERAÇÃO DO USUÁRIO =================================================================
  // Cliques, arraste (mover pontos/rótulos), snap em curvas existentes, e a lógica de cada
  // ferramenta da barra lateral (ponto, h-reta, h-segmento, h-ângulo, h-triângulo, ponto médio,
  // pé da perpendicular, refletir, mover, apagar).

  function ensureConnection(p1, p2, kind) {
    const already = lines.some(l =>
      (dist(l.p1.x, l.p1.y, p1.x, p1.y) < 0.01 && dist(l.p2.x, l.p2.y, p2.x, p2.y) < 0.01) ||
      (dist(l.p1.x, l.p1.y, p2.x, p2.y) < 0.01 && dist(l.p2.x, l.p2.y, p1.x, p1.y) < 0.01)
    ) || segments.some(s =>
      (dist(s.p1.x, s.p1.y, p1.x, p1.y) < 0.01 && dist(s.p2.x, s.p2.y, p2.x, p2.y) < 0.01) ||
      (dist(s.p1.x, s.p1.y, p2.x, p2.y) < 0.01 && dist(s.p2.x, s.p2.y, p1.x, p1.y) < 0.01)
    );
    if (already) return;
    const obj = { id: (kind === 'hline' ? 'l' : 's') + Date.now() + Math.random(), p1: { x: p1.x, y: p1.y }, p2: { x: p2.x, y: p2.y }, label: nextLineSegLabel() };
    if (kind === 'hline') lines.push(obj); else segments.push(obj);
  }

  function deletePoint(id) {
    const p = points.find(x => x.id === id);
    if (!p) return;
    pushHistory();
    points = points.filter(x => x.id !== id);
    lines = lines.filter(l => dist(l.p1.x,l.p1.y,p.x,p.y) > 0.01 && dist(l.p2.x,l.p2.y,p.x,p.y) > 0.01);
    segments = segments.filter(s => dist(s.p1.x,s.p1.y,p.x,p.y) > 0.01 && dist(s.p2.x,s.p2.y,p.x,p.y) > 0.01);
    angles = angles.filter(a => a.vId !== id && a.aId !== id && a.bId !== id);
    render();
  }

  function resetPending(msg) {
    pending = [];
    if (msg) hint.textContent = msg;
    render();
  }

  function handlePointClick(pt) {
    if (tool === 'hline' || tool === 'hsegment') {
      if (pending.length === 0) {
        pending = [pt];
        hint.textContent = 'Ponto ' + pt.label + ' selecionado — clique no segundo ponto.';
        render();
        return;
      }
      if (pending[0].id === pt.id) {
        resetPending('Clique em dois pontos.');
        return;
      }
      const p1 = pending[0];
      const p2 = pt;
      pushHistory();
      if (tool === 'hline') {
        lines.push({ id: 'l' + Date.now(), p1: { x: p1.x, y: p1.y }, p2: { x: p2.x, y: p2.y }, label: nextLineSegLabel() });
        resetPending('H-reta traçada. Clique em dois pontos para outra.');
      } else {
        segments.push({ id: 's' + Date.now(), p1: { x: p1.x, y: p1.y }, p2: { x: p2.x, y: p2.y }, label: nextLineSegLabel() });
        resetPending('H-segmento traçado. Clique em dois pontos para outro.');
      }
      return;
    }

    if (tool === 'hangle') {
      pending.push(pt);
      if (pending.length === 1) {
        hint.textContent = 'Ponto ' + pt.label + ' — este será um dos lados. Clique agora no vértice.';
        render();
      } else if (pending.length === 2) {
        hint.textContent = 'Vértice ' + pt.label + ' definido. Clique no ponto do outro lado.';
        render();
      } else {
        const pA = pending[0], pV = pending[1], pB = pending[2];
        if (pA.id === pV.id || pV.id === pB.id || pA.id === pB.id) {
          resetPending('Escolha três pontos distintos: lado, vértice, lado.');
          return;
        }
        pushHistory();
        angles.push({ id: 'a' + Date.now(), aId: pA.id, vId: pV.id, bId: pB.id, label: nextAngleLabel() });
        ensureConnection(pV, pA);
        ensureConnection(pV, pB);
        resetPending('H-ângulo criado. Clique: ponto do lado 1 → vértice → ponto do lado 2.');
      }
      return;
    }

    if (tool === 'htriangle') {
      pending.push(pt);
      if (pending.length < 3) {
        hint.textContent = 'Ponto ' + pt.label + ' definido (' + pending.length + '/3). Clique no próximo vértice.';
        render();
        return;
      }
      const [pA, pB, pC] = pending;
      if (pA.id === pB.id || pB.id === pC.id || pA.id === pC.id) {
        resetPending('Escolha três vértices distintos para o h-triângulo.');
        return;
      }
      pushHistory();
      segments.push({ id: 's' + Date.now() + 'a', p1: { x: pA.x, y: pA.y }, p2: { x: pB.x, y: pB.y }, label: nextLineSegLabel() });
      segments.push({ id: 's' + Date.now() + 'b', p1: { x: pB.x, y: pB.y }, p2: { x: pC.x, y: pC.y }, label: nextLineSegLabel() });
      segments.push({ id: 's' + Date.now() + 'c', p1: { x: pC.x, y: pC.y }, p2: { x: pA.x, y: pA.y }, label: nextLineSegLabel() });
      resetPending('H-triângulo criado. Clique em 3 pontos para outro.');
      return;
    }

    if (tool === 'midpoint') {
      pending.push(pt);
      if (pending.length === 1) {
        hint.textContent = 'Ponto ' + pt.label + ' selecionado — clique no segundo ponto do segmento.';
        render();
        return;
      }
      const [pA, pB] = pending;
      if (pA.id === pB.id) {
        resetPending('Escolha dois pontos distintos.');
        return;
      }
      const uA = toUnitDisk(pA.x, pA.y);
      const uB = toUnitDisk(pB.x, pB.y);
      const uM = hyperbolicMidpoint(uA, uB);
      if (!uM) {
        resetPending('Não foi possível calcular o ponto médio (pontos colineares com a origem em caso degenerado).');
        return;
      }
      const mPx = fromUnitDisk(uM.x, uM.y);
      pushHistory();
      const label = letterFor(pointCounter);
      pointCounter++;
      points.push({ id: 'p' + Date.now() + Math.random(), x: mPx.x, y: mPx.y, label });
      ensureConnection(pA, pB);
      resetPending('Ponto médio hiperbólico ' + label + ' criado.');
      return;
    }

    if (tool === 'perpfoot') {
      pending.push(pt);
      if (pending.length === 1) {
        hint.textContent = 'Ponto ' + pt.label + ' — este é o primeiro ponto da h-reta. Clique no segundo ponto da h-reta.';
        render();
        return;
      }
      if (pending.length === 2) {
        hint.textContent = 'H-reta definida por ' + pending[0].label + ' e ' + pt.label + '. Agora clique no ponto de onde baixar a perpendicular.';
        render();
        return;
      }
      const [pA, pB, pP] = pending;
      const uA = toUnitDisk(pA.x, pA.y);
      const uB = toUnitDisk(pB.x, pB.y);
      const uP = toUnitDisk(pP.x, pP.y);
      const uQ = footOfPerpendicular(uA, uB, uP);
      if (!uQ) {
        resetPending('Não foi possível calcular o pé da perpendicular.');
        return;
      }
      const qPx = fromUnitDisk(uQ.x, uQ.y);
      pushHistory();
      const label = letterFor(pointCounter);
      pointCounter++;
      const ptQ = { id: 'p' + Date.now() + Math.random(), x: qPx.x, y: qPx.y, label };
      points.push(ptQ);
      ensureConnection(pA, pB, 'hline');
      ensureConnection(pP, ptQ, 'hsegment');
      resetPending('Pé da perpendicular ' + label + ' criado.');
      return;
    }

    if (tool === 'reflect') {
      pending.push(pt);
      if (pending.length === 1) {
        hint.textContent = 'Ponto ' + pt.label + ' — primeiro ponto da h-reta espelho. Clique no segundo ponto da h-reta.';
        render();
        return;
      }
      if (pending.length === 2) {
        hint.textContent = 'H-reta espelho definida. Agora clique no ponto a refletir.';
        render();
        return;
      }
      const [pA, pB, pP] = pending;
      const uA = toUnitDisk(pA.x, pA.y);
      const uB = toUnitDisk(pB.x, pB.y);
      const uP = toUnitDisk(pP.x, pP.y);
      const uR = reflectPoint(uA, uB, uP);
      if (!uR) {
        resetPending('Não foi possível refletir esse ponto (está muito perto do centro do arco).');
        return;
      }
      const rPx = fromUnitDisk(uR.x, uR.y);
      pushHistory();
      const label = letterFor(pointCounter);
      pointCounter++;
      points.push({ id: 'p' + Date.now() + Math.random(), x: rPx.x, y: rPx.y, label });
      ensureConnection(pA, pB, 'hline');
      resetPending('Ponto refletido ' + label + ' criado.');
      return;
    }

    if (tool === 'delete') {
      deletePoint(pt.id);
      hint.textContent = 'Ponto removido (e objetos que dependiam dele).';
      return;
    }
  }

  // cria um ponto nas coordenadas de pixel (px,py), aplicando snap se estiver perto de uma curva.
  // retorna o ponto criado, ou null se estiver fora do disco e sem snap.
  function createPointAt(px, py, quiet) {
    const target = findSnapTarget(px, py);
    let finalPx = px, finalPy = py;
    let isIdeal = false;

    if (target) {
      finalPx = target.snappedPx.x;
      finalPy = target.snappedPx.y;
    } else {
      const d = dist(px, py, CX, CY);
      const IDEAL_ZONE = 14; // pixels de tolerância ao redor da fronteira para detectar intenção de ponto ideal
      if (d >= R - IDEAL_ZONE && d <= R + IDEAL_ZONE) {
        // clique próximo o bastante da fronteira: cria um ponto ideal, projetado exatamente sobre ela.
        const scale = R / d;
        finalPx = CX + (px - CX) * scale;
        finalPy = CY + (py - CY) * scale;
        isIdeal = true;
      } else if (d > R + IDEAL_ZONE) {
        if (!quiet) hint.textContent = 'Clique dentro do disco, ou bem próximo da borda para criar um ponto ideal (Ω).';
        return null;
      }
    }

    // segunda camada de segurança: mesmo após snap, o ponto final nunca pode estar fora do disco aberto
    // (esta checagem não se aplica a pontos ideais, que existem exatamente sobre a fronteira por definição).
    if (!isIdeal) {
      const finalNorm = dist(finalPx, finalPy, CX, CY) / R;
      if (finalNorm >= 0.97) {
        if (!quiet) hint.textContent = 'Ponto próximo demais da fronteira — tente clicar um pouco mais para o centro.';
        return null;
      }
    }

    pushHistory();
    const label = isIdeal ? nextIdealLabel() : letterFor(pointCounter);
    if (!isIdeal) pointCounter++;
    const pt = { id: 'p' + Date.now() + Math.random(), x: finalPx, y: finalPy, label, isIdeal };
    points.push(pt);
    snapTarget = null;
    return pt;
  }

  function pageToSvgCoords(ev) {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const scaleX = vb.width / rect.width;
    const scaleY = vb.height / rect.height;
    return {
      x: vb.x + (ev.clientX - rect.left) * scaleX,
      y: vb.y + (ev.clientY - rect.top) * scaleY
    };
  }

  svg.addEventListener('mousemove', (ev) => {
    const { x: px, y: py } = pageToSvgCoords(ev);

    if (draggingAngleLabelId !== null) {
      const ang = angles.find(a => a.id === draggingAngleLabelId);
      if (ang && ang._baseLabelPos) {
        ang.labelOffset = { x: px - ang._baseLabelPos.x, y: py - ang._baseLabelPos.y };
        render();
      }
      return;
    }

    if (draggingLineSegLabelId !== null) {
      const obj = lines.find(l => l.id === draggingLineSegLabelId) || segments.find(s => s.id === draggingLineSegLabelId);
      if (obj && obj._baseLabelPos) {
        obj.labelOffset = { x: px - obj._baseLabelPos.x, y: py - obj._baseLabelPos.y };
        render();
      }
      return;
    }

    if (draggingPointLabelId !== null) {
      const pt = points.find(p => p.id === draggingPointLabelId);
      if (pt) {
        pt.labelOffset = { x: px - pt.x, y: py - pt.y };
        render();
      }
      return;
    }

    if (draggingPointId !== null) {
      const d = dist(px, py, CX, CY);
      let finalPx = px, finalPy = py;

      if (draggingSnapGeom) {
        const uCursor = toUnitDisk(px, py);
        const rawProj = projectToGeom(draggingSnapGeom.geom, uCursor);
        let proj = draggingSnapGeom.kind === 'hsegment'
          ? clampToSegmentArc(draggingSnapGeom.geom, draggingSnapGeom.uA, draggingSnapGeom.uB, rawProj)
          : rawProj;

        // segurança: mesmo em h-reta (sem limite natural de extremos), o ponto nunca pode
        // ser projetado além da fronteira do disco aberto.
        const projNorm = Math.hypot(proj.x, proj.y);
        if (projNorm >= 0.95) {
          const scale = 0.95 / projNorm;
          proj = { x: proj.x * scale, y: proj.y * scale };
        }

        const projPx = fromUnitDisk(proj.x, proj.y);
        finalPx = projPx.x;
        finalPy = projPx.y;
      } else if (d >= R - 4) {
        const scale = (R - 4) / d;
        finalPx = CX + (px - CX) * scale;
        finalPy = CY + (py - CY) * scale;
      } else {
        const target = findSnapTarget(px, py);
        if (target) {
          finalPx = target.snappedPx.x;
          finalPy = target.snappedPx.y;
        }
      }

      const pt = points.find(p => p.id === draggingPointId);
      if (pt) {
        const dx = finalPx - pt.x;
        const dy = finalPy - pt.y;
        pt.x = finalPx;
        pt.y = finalPy;
        lines.forEach(l => {
          if (dist(l.p1.x, l.p1.y, pt.x - dx, pt.y - dy) < 0.01) { l.p1.x = finalPx; l.p1.y = finalPy; }
          if (dist(l.p2.x, l.p2.y, pt.x - dx, pt.y - dy) < 0.01) { l.p2.x = finalPx; l.p2.y = finalPy; }
        });
        segments.forEach(s => {
          if (dist(s.p1.x, s.p1.y, pt.x - dx, pt.y - dy) < 0.01) { s.p1.x = finalPx; s.p1.y = finalPy; }
          if (dist(s.p2.x, s.p2.y, pt.x - dx, pt.y - dy) < 0.01) { s.p2.x = finalPx; s.p2.y = finalPy; }
        });
      }
      render();
      return;
    }

    if (tool === 'point') {
      const target = findSnapTarget(px, py);
      if (target !== snapTarget) {
        snapTarget = target;
        render();
      }
    }
  });

  svg.addEventListener('mouseleave', () => {
    if (snapTarget) {
      snapTarget = null;
      render();
    }
  });

  svg.addEventListener('mouseup', () => {
    if (draggingAngleLabelId !== null) {
      draggingAngleLabelId = null;
      return;
    }
    if (draggingLineSegLabelId !== null) {
      draggingLineSegLabelId = null;
      return;
    }
    if (draggingPointLabelId !== null) {
      draggingPointLabelId = null;
      return;
    }
    if (draggingPointId !== null) {
      draggingPointId = null;
      draggingSnapGeom = null;
      hint.textContent = 'Ponto movido.';
      render();
    }
  });

  document.addEventListener('mouseup', () => {
    if (draggingAngleLabelId !== null) {
      draggingAngleLabelId = null;
      return;
    }
    if (draggingLineSegLabelId !== null) {
      draggingLineSegLabelId = null;
      return;
    }
    if (draggingPointLabelId !== null) {
      draggingPointLabelId = null;
      return;
    }
    if (draggingPointId !== null) {
      draggingPointId = null;
      draggingSnapGeom = null;
      render();
    }
  });

  const CONSTRUCTION_TOOLS = ['hline', 'hsegment', 'hangle', 'htriangle', 'midpoint', 'perpfoot', 'reflect'];

  svg.addEventListener('click', (ev) => {
    if (propPanel.style.display === 'block') {
      closePropPanel();
      return;
    }

    if (tool === 'point') {
      const { x: px, y: py } = pageToSvgCoords(ev);
      const target = findSnapTarget(px, py);
      const pt = createPointAt(px, py);
      if (pt) {
        hint.textContent = target
          ? 'Ponto ' + pt.label + ' criado sobre ' + (target.kind === 'hline' ? 'a h-reta' : 'o h-segmento') + '.'
          : 'Ponto ' + pt.label + ' criado. Clique para adicionar outro.';
      }
      render();
      return;
    }

    if (CONSTRUCTION_TOOLS.includes(tool)) {
      // clique em área vazia do disco: cria o ponto ali (com snap) e o encaminha
      // ao mesmo fluxo de handlePointClick, como se já existisse.
      const clickedOnExistingPoint = ev.target.closest && ev.target.closest('g[data-point-id]');
      if (clickedOnExistingPoint) return; // já tratado pelo próprio listener do ponto

      const { x: px, y: py } = pageToSvgCoords(ev);
      const pt = createPointAt(px, py, true);
      if (pt) {
        render();
        handlePointClick(pt);
      }
    }
  });

  const toolHints = {
    point: 'Clique dentro do disco para criar um ponto. Perto de uma reta ou segmento, o ponto cola nela.',
    hline: 'Clique em dois pontos para traçar uma h-reta (clique em área vazia cria o ponto ali).',
    hsegment: 'Clique em dois pontos para traçar um h-segmento (clique em área vazia cria o ponto ali).',
    hangle: 'Clique: ponto do lado 1 → vértice → ponto do lado 2.',
    htriangle: 'Clique em 3 pontos para formar um h-triângulo.',
    midpoint: 'Clique em dois pontos: cria o ponto médio hiperbólico entre eles.',
    perpfoot: 'Clique em dois pontos (h-reta) e depois num terceiro: cria o pé da perpendicular.',
    reflect: 'Clique em dois pontos (h-reta espelho) e depois no ponto a refletir.',
    move: 'Arraste um ponto para movê-lo.',
    delete: 'Clique num ponto, h-reta, h-segmento ou h-ângulo para apagar.'
  };

  document.querySelectorAll('button.tool').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('button.tool').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      tool = btn.dataset.tool;
      pending = [];
      hint.textContent = toolHints[tool] || '';
      render();
    });
  });

  // --- painel de propriedades (cor/espessura) ---
  // ===== 6. PAINEL DE PROPRIEDADES ===============================================================
  // Duplo-clique ou clique-direito em um objeto abre um painel flutuante para ajustar cor,
  // espessura, estilo de traço e visibilidade (do objeto, do rótulo, e do valor exibido).

  const PROP_COLORS = ['#2b6f5c', '#2a5c8a', '#8a6d1f', '#8a3324', '#5b3a8a', '#1c1a17'];
  let propTarget = null;

  const propPanel = document.getElementById('propPanel');
  const propTitle = document.getElementById('propTitle');
  const propSwatches = document.getElementById('propSwatches');
  const propWidth = document.getElementById('propWidth');
  const propDash = document.getElementById('propDash');
  const propCloseBtn = document.getElementById('propCloseBtn');
  const propVisible = document.getElementById('propVisible');
  const propLabelVisible = document.getElementById('propLabelVisible');
  const propShowValue = document.getElementById('propShowValue');

  function openPropPanel(obj, label, ev) {
    propTarget = obj;
    propTitle.textContent = label;

    propSwatches.innerHTML = '';
    PROP_COLORS.forEach(color => {
      const sw = document.createElement('span');
      sw.className = 'prop-swatch' + (obj.customColor === color ? ' selected' : '');
      sw.style.background = color;
      sw.addEventListener('click', () => {
        obj.customColor = color;
        propSwatches.querySelectorAll('.prop-swatch').forEach(s => s.classList.remove('selected'));
        sw.classList.add('selected');
        render();
      });
      propSwatches.appendChild(sw);
    });

    propWidth.value = obj.customWidth || (label === 'H-ângulo' ? 1.8 : 2);
    document.getElementById('propWidthRow').style.display = (label === 'Ponto') ? 'none' : 'flex';
    document.getElementById('propDashRow').style.display = (label === 'Ponto') ? 'none' : 'flex';
    propDash.value = obj.dashStyle || 'solid';
    propVisible.checked = obj.visible !== false;
    propLabelVisible.checked = obj.labelVisible !== false;

    const showValueRow = document.getElementById('propShowValueRow');
    const showValueLabel = document.getElementById('propShowValueLabel');
    if (label === 'H-ângulo') {
      showValueRow.style.display = 'flex';
      showValueLabel.textContent = 'Mostrar valor';
      propShowValue.checked = obj.showValue !== false;
    } else if (label === 'H-segmento') {
      showValueRow.style.display = 'flex';
      showValueLabel.textContent = 'Mostrar comprimento';
      propShowValue.checked = obj.showValue === true; // padrão desligado para comprimento
    } else {
      showValueRow.style.display = 'none';
    }

    propPanel.style.display = 'block';

    const wrapRect = svg.parentElement.getBoundingClientRect();
    const relX = ev.clientX - wrapRect.left;
    const relY = ev.clientY - wrapRect.top;
    propPanel.style.left = Math.min(relX, wrapRect.width - 180) + 'px';
    propPanel.style.top = Math.min(relY, wrapRect.height - 190) + 'px';
  }

  function closePropPanel() {
    propTarget = null;
    propPanel.style.display = 'none';
  }

  propWidth.addEventListener('input', () => {
    if (propTarget) {
      propTarget.customWidth = parseFloat(propWidth.value);
      render();
    }
  });

  propDash.addEventListener('change', () => {
    if (propTarget) {
      propTarget.dashStyle = propDash.value;
      render();
    }
  });

  propVisible.addEventListener('change', () => {
    if (propTarget) {
      propTarget.visible = propVisible.checked;
      render();
    }
  });

  propLabelVisible.addEventListener('change', () => {
    if (propTarget) {
      propTarget.labelVisible = propLabelVisible.checked;
      render();
    }
  });

  propShowValue.addEventListener('change', () => {
    if (propTarget) {
      propTarget.showValue = propShowValue.checked;
      render();
    }
  });

  propCloseBtn.addEventListener('click', closePropPanel);

  document.getElementById('clearBtn').addEventListener('click', () => {
    pushHistory();
    points = [];
    lines = [];
    segments = [];
    angles = [];
    pointCounter = 0;
    lineSegCounter = 0;
    angleCounter = 0;
    pending = [];
    hint.textContent = 'Tudo limpo. Clique dentro do disco para criar um ponto.';
    render();
  });

  // --- undo / redo ---
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');

  function refreshHistoryButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  document.addEventListener('keydown', (ev) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modKey = isMac ? ev.metaKey : ev.ctrlKey;
    if (!modKey || ev.key.toLowerCase() !== 'z') return;
    ev.preventDefault();
    if (ev.shiftKey) { redo(); } else { undo(); }
  });

  // --- exportar / importar (.json) ---
  document.getElementById('exportBtn').addEventListener('click', () => {
    const data = captureState();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'poincarelab-construcao.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    hint.textContent = 'Construção exportada.';
  });

  const importFileInput = document.getElementById('importFileInput');
  document.getElementById('importBtn').addEventListener('click', () => importFileInput.click());

  importFileInput.addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!Array.isArray(data.points) || !Array.isArray(data.lines) || !Array.isArray(data.segments) || !Array.isArray(data.angles)) {
          throw new Error('Formato inválido');
        }
        pushHistory();
        restoreState(data);
        render();
        hint.textContent = 'Construção importada.';
      } catch (err) {
        hint.textContent = 'Não foi possível importar: arquivo inválido ou corrompido.';
      }
      importFileInput.value = '';
    };
    reader.readAsText(file);
  });

  // --- zoom: controla a "câmera" via viewBox, sem alterar as coordenadas internas dos objetos ---
  // ===== 7. ZOOM ==================================================================================
  // Controla a "câmera" via viewBox do <svg> — as coordenadas internas dos objetos nunca mudam,
  // só a janela visível. Scroll do mouse ou os botões +/−/reset.

  let zoomLevel = 1;
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 4;

  function applyViewBox() {
    const w = SIZE / zoomLevel;
    const h = SIZE / zoomLevel;
    const x = CX - w / 2;
    const y = CY - h / 2;
    svg.setAttribute('viewBox', x + ' ' + y + ' ' + w + ' ' + h);
  }

  function setZoom(newZoom) {
    zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
    applyViewBox();
  }

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoom(zoomLevel * factor);
  }, { passive: false });

  document.getElementById('zoomInBtn').addEventListener('click', () => setZoom(zoomLevel * 1.25));
  document.getElementById('zoomOutBtn').addEventListener('click', () => setZoom(zoomLevel / 1.25));
  document.getElementById('zoomResetBtn').addEventListener('click', () => setZoom(1));

  // --- comandos de texto (estilo GeoGebra): "nome = Comando(arg1, arg2, ...)" ---

  // ===== 8. SISTEMA DE COMANDOS DE TEXTO =========================================================
  // Caixa de comando estilo GeoGebra: "nome = Comando(args)" para construção direta, ou
  // "nome = Comando(args) | Medida(...) == valor" para resolver um ponto por restrição de ângulo
  // (deslizando sobre uma curva já definida, ou variando a direção a partir de um ponto de
  // referência a distância hiperbólica fixa — ver solveConstraintOnCurve / solveConstraintByDirection).

  function findPointByLabel(label) {
    return points.find(p => p.label === label) || null;
  }

  // resolve um argumento textual em um ponto real: nome de ponto já existente, ou "x,y"
  // (coordenadas no disco unitário, entre -1 e 1) para criar um ponto novo na hora.
  function resolvePointArg(raw) {
    const trimmed = raw.trim();
    const existing = findPointByLabel(trimmed);
    if (existing) return existing;

    const coordMatch = trimmed.match(/^\(?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)?$/);
    if (coordMatch) {
      const ux = parseFloat(coordMatch[1]);
      const uy = parseFloat(coordMatch[2]);
      if (Math.hypot(ux, uy) >= 0.97) return null; // fora do disco aberto
      const px = fromUnitDisk(ux, uy);
      const label = letterFor(pointCounter);
      pointCounter++;
      const pt = { id: 'p' + Date.now() + Math.random(), x: px.x, y: px.y, label };
      points.push(pt);
      return pt;
    }

    return null; // nome desconhecido e não é coordenada válida
  }

  function parseCommandLine(line) {
    // formatos aceitos:
    //   "nome = Comando(a, b, c)"                              (definição direta)
    //   "nome = Comando(a, b, c) | Medida(...) == valor"        (definição com restrição)
    const pipeIdx = line.indexOf('|');
    const defPart = pipeIdx === -1 ? line : line.slice(0, pipeIdx);
    const constraintPart = pipeIdx === -1 ? null : line.slice(pipeIdx + 1).trim();

    const m = defPart.match(/^\s*(?:([A-Za-zΩ][\wΩ₀-₉]*)\s*=\s*)?([A-Za-zÀ-ÿ]+)\s*\(\s*(.*?)\s*\)\s*$/);
    if (!m) return null;
    const [, outputName, command, argsRaw] = m;
    const args = argsRaw.length === 0 ? [] : argsRaw.split(',').map(a => a.trim());

    let constraint = null;
    if (constraintPart) {
      const cm = constraintPart.match(/^([A-Za-zÀ-ÿ]+)\s*\(\s*(.*?)\s*\)\s*(==|=)\s*(-?[\d.]+)\s*(?:\[\s*(\d+)\s*\])?\s*$/);
      if (!cm) return { outputName, command, args, constraintError: 'Restrição mal formatada. Use: Medida(...) == valor, opcionalmente seguido de [índice].' };
      const [, measureCommand, measureArgsRaw, , targetRaw, solutionIndexRaw] = cm;
      const measureArgs = measureArgsRaw.split(',').map(a => a.trim());
      const solutionIndex = solutionIndexRaw !== undefined ? parseInt(solutionIndexRaw, 10) - 1 : 0;
      constraint = { measureCommand, measureArgs, target: parseFloat(targetRaw), solutionIndex };
    }

    return { outputName, command, args, constraint };
  }

  const COMMANDS = {
    Ponto(args) {
      if (args.length !== 2) throw new Error('Ponto precisa de 2 coordenadas: Ponto(x, y)');
      const ux = parseFloat(args[0]);
      const uy = parseFloat(args[1]);
      if (isNaN(ux) || isNaN(uy)) throw new Error('Coordenadas inválidas.');
      if (Math.hypot(ux, uy) >= 0.97) throw new Error('Ponto fora do disco hiperbólico.');
      const px = fromUnitDisk(ux, uy);
      const label = letterFor(pointCounter);
      pointCounter++;
      const pt = { id: 'p' + Date.now() + Math.random(), x: px.x, y: px.y, label };
      points.push(pt);
      return { kind: 'point', obj: pt };
    },

    Reta(args) {
      if (args.length !== 2) throw new Error('Reta precisa de 2 pontos: Reta(A, B)');
      const A = resolvePointArg(args[0]);
      const B = resolvePointArg(args[1]);
      if (!A || !B) throw new Error('Ponto não encontrado: ' + (!A ? args[0] : args[1]));
      if (A.id === B.id) throw new Error('Os dois pontos precisam ser distintos.');
      const obj = { id: 'l' + Date.now() + Math.random(), p1: { x: A.x, y: A.y }, p2: { x: B.x, y: B.y }, label: nextLineSegLabel() };
      lines.push(obj);
      return { kind: 'hline', obj };
    },

    Segmento(args) {
      if (args.length !== 2) throw new Error('Segmento precisa de 2 pontos: Segmento(A, B)');
      const A = resolvePointArg(args[0]);
      const B = resolvePointArg(args[1]);
      if (!A || !B) throw new Error('Ponto não encontrado: ' + (!A ? args[0] : args[1]));
      if (A.id === B.id) throw new Error('Os dois pontos precisam ser distintos.');
      const obj = { id: 's' + Date.now() + Math.random(), p1: { x: A.x, y: A.y }, p2: { x: B.x, y: B.y }, label: nextLineSegLabel() };
      segments.push(obj);
      return { kind: 'hsegment', obj };
    },

    Angulo(args) {
      if (args.length !== 3) throw new Error('Angulo precisa de 3 pontos: Angulo(A, V, B) — V é o vértice');
      const A = resolvePointArg(args[0]);
      const V = resolvePointArg(args[1]);
      const B = resolvePointArg(args[2]);
      if (!A || !V || !B) throw new Error('Ponto não encontrado entre os argumentos.');
      if (A.id === V.id || V.id === B.id || A.id === B.id) throw new Error('Os três pontos precisam ser distintos.');
      const obj = { id: 'a' + Date.now() + Math.random(), aId: A.id, vId: V.id, bId: B.id, label: nextAngleLabel() };
      angles.push(obj);
      ensureConnection(V, A);
      ensureConnection(V, B);
      return { kind: 'hangle', obj };
    },

    Medio(args) {
      if (args.length !== 2) throw new Error('Medio precisa de 2 pontos: Medio(A, B)');
      const A = resolvePointArg(args[0]);
      const B = resolvePointArg(args[1]);
      if (!A || !B) throw new Error('Ponto não encontrado: ' + (!A ? args[0] : args[1]));
      if (A.id === B.id) throw new Error('Os dois pontos precisam ser distintos.');
      const uA = toUnitDisk(A.x, A.y);
      const uB = toUnitDisk(B.x, B.y);
      const uM = hyperbolicMidpoint(uA, uB);
      if (!uM) throw new Error('Não foi possível calcular o ponto médio (caso degenerado).');
      const mPx = fromUnitDisk(uM.x, uM.y);
      const label = letterFor(pointCounter);
      pointCounter++;
      const pt = { id: 'p' + Date.now() + Math.random(), x: mPx.x, y: mPx.y, label };
      points.push(pt);
      ensureConnection(A, B);
      return { kind: 'point', obj: pt };
    },

    Perpendicular(args) {
      if (args.length !== 3) throw new Error('Perpendicular precisa de 3 pontos: Perpendicular(A, B, P) — A,B definem a reta base');
      const A = resolvePointArg(args[0]);
      const B = resolvePointArg(args[1]);
      const P = resolvePointArg(args[2]);
      if (!A || !B || !P) throw new Error('Ponto não encontrado entre os argumentos.');
      const uA = toUnitDisk(A.x, A.y);
      const uB = toUnitDisk(B.x, B.y);
      const uP = toUnitDisk(P.x, P.y);
      const uQ = footOfPerpendicular(uA, uB, uP);
      if (!uQ) throw new Error('Não foi possível calcular o pé da perpendicular.');
      const qPx = fromUnitDisk(uQ.x, uQ.y);
      const label = letterFor(pointCounter);
      pointCounter++;
      const ptQ = { id: 'p' + Date.now() + Math.random(), x: qPx.x, y: qPx.y, label };
      points.push(ptQ);
      ensureConnection(A, B, 'hline');
      ensureConnection(P, ptQ, 'hsegment');
      return { kind: 'point', obj: ptQ };
    },

    Refletir(args) {
      if (args.length !== 3) throw new Error('Refletir precisa de 3 pontos: Refletir(A, B, P) — A,B definem a reta espelho');
      const A = resolvePointArg(args[0]);
      const B = resolvePointArg(args[1]);
      const P = resolvePointArg(args[2]);
      if (!A || !B || !P) throw new Error('Ponto não encontrado entre os argumentos.');
      const uA = toUnitDisk(A.x, A.y);
      const uB = toUnitDisk(B.x, B.y);
      const uP = toUnitDisk(P.x, P.y);
      const uR = reflectPoint(uA, uB, uP);
      if (!uR) throw new Error('Não foi possível refletir esse ponto.');
      const rPx = fromUnitDisk(uR.x, uR.y);
      const label = letterFor(pointCounter);
      pointCounter++;
      const pt = { id: 'p' + Date.now() + Math.random(), x: rPx.x, y: rPx.y, label };
      points.push(pt);
      ensureConnection(A, B, 'hline');
      return { kind: 'point', obj: pt };
    },

    Triangulo(args) {
      if (args.length !== 3) throw new Error('Triangulo precisa de 3 pontos: Triangulo(A, B, C)');
      const A = resolvePointArg(args[0]);
      const B = resolvePointArg(args[1]);
      const C = resolvePointArg(args[2]);
      if (!A || !B || !C) throw new Error('Ponto não encontrado entre os argumentos.');
      if (A.id === B.id || B.id === C.id || A.id === C.id) throw new Error('Os três vértices precisam ser distintos.');
      const s1 = { id: 's' + Date.now() + Math.random(), p1: { x: A.x, y: A.y }, p2: { x: B.x, y: B.y }, label: nextLineSegLabel() };
      const s2 = { id: 's' + Date.now() + Math.random(), p1: { x: B.x, y: B.y }, p2: { x: C.x, y: C.y }, label: nextLineSegLabel() };
      const s3 = { id: 's' + Date.now() + Math.random(), p1: { x: C.x, y: C.y }, p2: { x: A.x, y: A.y }, label: nextLineSegLabel() };
      segments.push(s1, s2, s3);
      return { kind: 'hsegment', obj: s1 };
    }
  };

  // rebatiza o objeto de saída com o nome dado pelo usuário (ex: "r = Reta(A,B)" → r.label = "r"),
  // sobrepondo o nome automático gerado pelo comando.
  function applyOutputName(result, outputName) {
    if (!outputName || !result) return;
    result.obj.label = outputName;
  }

  // resolve um ponto sobre a curva definida por (uA, uB) tal que a medida indicada pela restrição
  // (hoje, só Angulo) bata com o valor alvo. measureArgs referencia o próprio ponto sendo resolvido
  // pelo outputName (ex: "Q" em "Angulo(P, Q, A) == 90"); os demais argumentos já precisam existir.
  function solveConstraintOnCurve(uA, uB, outputName, constraint) {
    if (constraint.measureCommand !== 'Angulo') {
      throw new Error('Restrição de "' + constraint.measureCommand + '" ainda não suportada — por enquanto, só Angulo(...) == valor.');
    }
    if (constraint.measureArgs.length !== 3) {
      throw new Error('Angulo precisa de 3 pontos na restrição: Angulo(A, ' + outputName + ', B) == valor');
    }
    const idxOut = constraint.measureArgs.indexOf(outputName);
    if (idxOut === -1) {
      throw new Error('A restrição precisa referenciar "' + outputName + '" (o ponto sendo resolvido).');
    }

    const otherNames = constraint.measureArgs.filter((_, i) => i !== idxOut);
    const otherPoints = otherNames.map(n => {
      const p = resolvePointArg(n);
      if (!p) throw new Error('Ponto não encontrado na restrição: ' + n);
      return p;
    });
    const fixedUnit = otherPoints.map(p => toUnitDisk(p.x, p.y));

    const geom = buildHLineGeom(uA, uB);
    if (!geom) throw new Error('Não foi possível construir a curva base.');

    // a medida do ângulo tem uma descontinuidade genuína sempre que o ponto candidato Q coincide
    // com um dos "outros" pontos da restrição (o segmento degenera). Localizamos o parâmetro t de
    // cada um desses pontos, quando eles pertencem à própria curva-base, para excluir uma pequena
    // vizinhança ao redor durante a busca — evitando que a varredura confunda esse salto com uma
    // raiz genuína.
    const EXCLUDE_RADIUS = 0.02;
    const excludedTs = [];
    fixedUnit.forEach(fp => {
      const onA = Math.hypot(fp.x - uA.x, fp.y - uA.y) < 1e-6;
      const onB = Math.hypot(fp.x - uB.x, fp.y - uB.y) < 1e-6;
      if (onA) excludedTs.push(0);
      if (onB) excludedTs.push(1);
    });
    function isExcluded(t) {
      return excludedTs.some(et => Math.abs(t - et) < EXCLUDE_RADIUS);
    }

    function angleDiffAt(t) {
      const Qc = pointAtParam(geom, uA, uB, t);
      const trio = constraint.measureArgs.map((name, i) => i === idxOut ? Qc : fixedUnit[otherNames.indexOf(name)]);
      const V = trio[1], A = trio[0], B = trio[2];
      const measured = measureAngle(V, A, B);
      if (!measured) return null;
      return measured.measureDeg - constraint.target;
    }

    const N = 400;
    let prevT = -0.5;
    let prevVal = isExcluded(prevT) ? null : angleDiffAt(prevT);
    let rootT = null;
    for (let i = 1; i <= N; i++) {
      const t = -0.5 + i * (2.0 / N);
      if (isExcluded(t)) { prevT = t; prevVal = null; continue; }
      const val = angleDiffAt(t);
      if (prevVal !== null && val !== null && prevVal * val < 0) {
        let lo = prevT, hi = t;
        for (let k = 0; k < 60; k++) {
          const mid = (lo + hi) / 2;
          if (isExcluded(mid)) break;
          const flo = angleDiffAt(lo);
          const fmid = angleDiffAt(mid);
          if (flo !== null && fmid !== null && flo * fmid <= 0) hi = mid; else lo = mid;
        }
        rootT = (lo + hi) / 2;
        break;
      }
      prevT = t;
      prevVal = val;
    }
    if (rootT === null) {
      throw new Error('Não foi possível encontrar um ponto na curva que satisfaça essa condição.');
    }
    return pointAtParam(geom, uA, uB, rootT);
  }

  // resolve TODAS as posições possíveis de um ponto B, a uma distância hiperbólica fixa (padrão 1.0)
  // de um ponto de referência A, tal que a medida de ângulo indicada bata com o valor alvo. Como o
  // ângulo tem, em geral, duas direções simétricas que o satisfazem, retorna a lista de soluções —
  // quem chama escolhe qual usar (por índice, quando houver mais de uma).
  const DEFAULT_CONSTRAINT_DIST = 1.0;

  function solveConstraintByDirection(refPointName, outputName, constraint) {
    if (constraint.measureCommand !== 'Angulo') {
      throw new Error('Restrição de "' + constraint.measureCommand + '" ainda não suportada — por enquanto, só Angulo(...) == valor.');
    }
    if (constraint.measureArgs.length !== 3) {
      throw new Error('Angulo precisa de 3 pontos na restrição.');
    }
    const idxOut = constraint.measureArgs.indexOf(outputName);
    if (idxOut === -1) {
      throw new Error('A restrição precisa referenciar "' + outputName + '" (o ponto sendo resolvido).');
    }
    const refPoint = resolvePointArg(refPointName);
    if (!refPoint) throw new Error('Ponto de referência não encontrado: ' + refPointName);
    const uRef = toUnitDisk(refPoint.x, refPoint.y);

    const otherNames = constraint.measureArgs.filter((_, i) => i !== idxOut);
    const otherPoints = otherNames.map(n => {
      if (n === refPointName) return refPoint;
      const p = resolvePointArg(n);
      if (!p) throw new Error('Ponto não encontrado na restrição: ' + n);
      return p;
    });
    const fixedUnit = otherPoints.map(p => toUnitDisk(p.x, p.y));

    function angleDiffAt(theta) {
      const Bc = pointAtHyperbolicDirection(uRef, theta, DEFAULT_CONSTRAINT_DIST);
      if (Math.hypot(Bc.x, Bc.y) >= 0.97) return null; // direção levaria para fora do disco (não deveria ocorrer com dist fixa, mas por segurança)
      const trio = constraint.measureArgs.map((name, i) => i === idxOut ? Bc : fixedUnit[otherNames.indexOf(name)]);
      const V = trio[1], A = trio[0], B = trio[2];
      const measured = measureAngle(V, A, B);
      if (!measured) return null;
      return measured.measureDeg - constraint.target;
    }

    const N = 720;
    let prevTheta = 0;
    let prevVal = angleDiffAt(prevTheta);
    const roots = [];
    for (let i = 1; i <= N; i++) {
      const theta = i * (2 * Math.PI / N);
      const val = angleDiffAt(theta);
      if (prevVal !== null && val !== null && prevVal * val < 0) {
        let lo = prevTheta, hi = theta;
        for (let k = 0; k < 60; k++) {
          const mid = (lo + hi) / 2;
          const flo = angleDiffAt(lo);
          const fmid = angleDiffAt(mid);
          if (flo !== null && fmid !== null && flo * fmid <= 0) hi = mid; else lo = mid;
        }
        roots.push((lo + hi) / 2);
      }
      prevTheta = theta;
      prevVal = val;
    }
    if (roots.length === 0) {
      throw new Error('Não foi encontrada nenhuma posição para "' + outputName + '" que satisfaça essa condição.');
    }
    return roots.map(theta => pointAtHyperbolicDirection(uRef, theta, DEFAULT_CONSTRAINT_DIST));
  }

  function executeCommandLine(rawLine) {
    const feedback = document.getElementById('commandFeedback');
    const line = rawLine.trim();
    if (!line) return;

    const parsed = parseCommandLine(line);
    if (!parsed) {
      feedback.textContent = 'Formato não reconhecido. Use: nome = Comando(args)';
      feedback.className = 'command-feedback error';
      return;
    }

    const { outputName, command, args, constraint, constraintError } = parsed;
    if (constraintError) {
      feedback.textContent = constraintError;
      feedback.className = 'command-feedback error';
      return;
    }
    if (outputName && findPointByLabel(outputName)) {
      feedback.textContent = 'Já existe um ponto chamado "' + outputName + '".';
      feedback.className = 'command-feedback error';
      return;
    }

    // com restrição, o comando principal (Reta/Segmento) define a CURVA sobre a qual resolver
    // um ponto — o nome de saída não vira a curva, vira o ponto resolvido sobre ela.
    if (constraint) {
      if (command !== 'Reta' && command !== 'Segmento') {
        feedback.textContent = 'Restrições só são suportadas sobre Reta(...) ou Segmento(...) por enquanto.';
        feedback.className = 'command-feedback error';
        return;
      }
      if (!outputName) {
        feedback.textContent = 'Uma restrição precisa de um nome de saída: nome = ' + command + '(A, B) | ...';
        feedback.className = 'command-feedback error';
        return;
      }
      if (args.length !== 2) {
        feedback.textContent = command + ' precisa de 2 pontos: ' + command + '(A, B)';
        feedback.className = 'command-feedback error';
        return;
      }

      // Modo 1 (deslizar sobre curva): "V = Reta(A,B) | Angulo(A,V,B) == 90" — A e B já existem,
      // V é um ponto novo que varia SOBRE a reta A-B.
      // Modo 2 (resolver por direção): "r = Reta(A,B) | Angulo(A,B,C) == 45" — um dos dois
      // argumentos de Reta/Segmento (aqui, B) ainda não existe e é o próprio nome de saída da
      // restrição: ele varia livremente em torno do OUTRO argumento (A), a distância fixa.
      // Critério de decisão entre os dois modos: NÃO depende de o ponto já existir, e sim de
      // ONDE o nome aparece dentro da restrição.
      //   Modo 1 (deslizar sobre curva): o outputName ('r') aparece DENTRO de Angulo(...) — ele
      //     é o próprio ponto variando sobre a curva definida pelos dois argumentos de Reta/Segmento,
      //     que já precisam existir e ficam fixos.
      //   Modo 2 (resolver/mover por direção): um dos ARGUMENTOS de Reta/Segmento (não o
      //     outputName) aparece dentro de Angulo(...) — esse argumento é quem varia a partir do
      //     outro argumento (fixo). Se esse ponto já existir, ele é MOVIDO para a posição
      //     resolvida; se não existir, é criado ali.
      const outputInConstraint = constraint.measureArgs.includes(outputName);
      const arg0InConstraint = constraint.measureArgs.includes(args[0]);
      const arg1InConstraint = constraint.measureArgs.includes(args[1]);

      let mode;
      if (outputInConstraint) {
        mode = 1;
      } else if (arg1InConstraint) {
        mode = 2; // args[1] (ex: 'B') varia a partir de args[0] (ex: 'A')
      } else if (arg0InConstraint) {
        mode = 2; // args[0] varia a partir de args[1] — mesma lógica, papéis trocados
      } else {
        feedback.textContent = 'A restrição precisa referenciar "' + outputName + '" ou um dos pontos de ' + command + '(' + args[0] + ', ' + args[1] + ').';
        feedback.className = 'command-feedback error';
        return;
      }

      const argPointA = findPointByLabel(args[0]);
      const argPointB = findPointByLabel(args[1]);

      pushHistory();
      try {
        if (mode === 1) {
          // Modo 1: ambos os pontos da curva já existem; outputName é um ponto novo sobre ela.
          if (!argPointA || !argPointB) throw new Error('Ponto não encontrado: ' + (!argPointA ? args[0] : args[1]));
          if (findPointByLabel(outputName)) throw new Error('Já existe um ponto chamado "' + outputName + '".');
          const uA = toUnitDisk(argPointA.x, argPointA.y);
          const uB = toUnitDisk(argPointB.x, argPointB.y);
          const uSolved = solveConstraintOnCurve(uA, uB, outputName, constraint);
          const solvedPx = fromUnitDisk(uSolved.x, uSolved.y);
          const pt = { id: 'p' + Date.now() + Math.random(), x: solvedPx.x, y: solvedPx.y, label: outputName };
          points.push(pt);
          ensureConnection(argPointA, argPointB, command === 'Reta' ? 'hline' : 'hsegment');
          render();
          feedback.textContent = 'OK: ' + outputName + ' resolvido sobre a curva.';
          feedback.className = 'command-feedback success';
        } else {
          // Modo 2: o argumento que aparece na restrição é quem varia a partir do outro (fixo).
          // Se esse ponto já existir, ele é MOVIDO para a posição resolvida; senão, é criado ali.
          const varyIdx = arg1InConstraint ? 1 : 0;
          const varyName = args[varyIdx];
          const refName = args[1 - varyIdx];
          const refPoint = findPointByLabel(refName);
          if (!refPoint) throw new Error('Ponto de referência não encontrado: ' + refName);

          const solutions = solveConstraintByDirection(refName, varyName, constraint);
          if (constraint.solutionIndex < 0 || constraint.solutionIndex >= solutions.length) {
            throw new Error('Índice de solução inválido: existem ' + solutions.length + ' solução(ões) possível(is), numeradas de [1] a [' + solutions.length + '].');
          }
          const chosen = solutions[constraint.solutionIndex];
          const multiHint = solutions.length > 1 ? ' (' + solutions.length + ' soluções possíveis; use [1], [2]... para escolher outra)' : '';
          const solvedPx = fromUnitDisk(chosen.x, chosen.y);

          const existingVaryPoint = findPointByLabel(varyName);
          let pt;
          if (existingVaryPoint) {
            // move o ponto existente para a nova posição resolvida; objetos que o referenciam
            // por coordenada (retas, segmentos, ângulos já desenhados) precisam ser realinhados.
            const oldX = existingVaryPoint.x, oldY = existingVaryPoint.y;
            existingVaryPoint.x = solvedPx.x;
            existingVaryPoint.y = solvedPx.y;
            lines.forEach(l => {
              if (dist(l.p1.x, l.p1.y, oldX, oldY) < 0.01) { l.p1.x = solvedPx.x; l.p1.y = solvedPx.y; }
              if (dist(l.p2.x, l.p2.y, oldX, oldY) < 0.01) { l.p2.x = solvedPx.x; l.p2.y = solvedPx.y; }
            });
            segments.forEach(s => {
              if (dist(s.p1.x, s.p1.y, oldX, oldY) < 0.01) { s.p1.x = solvedPx.x; s.p1.y = solvedPx.y; }
              if (dist(s.p2.x, s.p2.y, oldX, oldY) < 0.01) { s.p2.x = solvedPx.x; s.p2.y = solvedPx.y; }
            });
            pt = existingVaryPoint;
          } else {
            pt = { id: 'p' + Date.now() + Math.random(), x: solvedPx.x, y: solvedPx.y, label: varyName };
            points.push(pt);
          }

          const A = varyIdx === 0 ? pt : refPoint;
          const B = varyIdx === 0 ? refPoint : pt;
          const existingLine = command === 'Reta'
            ? lines.find(l => dist(l.p1.x, l.p1.y, A.x, A.y) < 0.01 && dist(l.p2.x, l.p2.y, B.x, B.y) < 0.01 || dist(l.p1.x, l.p1.y, B.x, B.y) < 0.01 && dist(l.p2.x, l.p2.y, A.x, A.y) < 0.01)
            : segments.find(s => dist(s.p1.x, s.p1.y, A.x, A.y) < 0.01 && dist(s.p2.x, s.p2.y, B.x, B.y) < 0.01 || dist(s.p1.x, s.p1.y, B.x, B.y) < 0.01 && dist(s.p2.x, s.p2.y, A.x, A.y) < 0.01);
          if (existingLine) {
            existingLine.p1 = { x: A.x, y: A.y };
            existingLine.p2 = { x: B.x, y: B.y };
            if (findPointByLabel(outputName) === null && outputName !== existingLine.label) existingLine.label = outputName;
          } else if (command === 'Reta') {
            lines.push({ id: 'l' + Date.now() + Math.random(), p1: { x: A.x, y: A.y }, p2: { x: B.x, y: B.y }, label: outputName });
          } else {
            segments.push({ id: 's' + Date.now() + Math.random(), p1: { x: A.x, y: A.y }, p2: { x: B.x, y: B.y }, label: outputName });
          }
          render();
          feedback.textContent = 'OK: ' + varyName + (existingVaryPoint ? ' movido' : ' criado') + ' e ' + outputName + ' resolvidos.' + multiHint;
          feedback.className = 'command-feedback success';
        }
      } catch (err) {
        undo();
        redoStack.length = 0;
        feedback.textContent = err.message;
        feedback.className = 'command-feedback error';
      }
      return;
    }

    const fn = COMMANDS[command];
    if (!fn) {
      feedback.textContent = 'Comando desconhecido: ' + command + '. Disponíveis: ' + Object.keys(COMMANDS).join(', ');
      feedback.className = 'command-feedback error';
      return;
    }

    pushHistory();
    try {
      const result = fn(args);
      applyOutputName(result, outputName);
      render();
      feedback.textContent = 'OK: ' + (outputName || result.obj.label) + ' criado.';
      feedback.className = 'command-feedback success';
    } catch (err) {
      undo(); // desfaz o pushHistory, já que o comando falhou no meio
      redoStack.length = 0;
      feedback.textContent = err.message;
      feedback.className = 'command-feedback error';
    }
  }

  const commandInput = document.getElementById('commandInput');
  commandInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      executeCommandLine(commandInput.value);
      commandInput.value = '';
    }
  });

  refreshHistoryButtons();
  render();
})();
