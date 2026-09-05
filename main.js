const { Plugin, ItemView, WorkspaceLeaf, Notice, TFile } = require('obsidian');

const VIEW_TYPE_MINDMAP = 'cds-mindmap-view';

const BRANCH_COLORS = [
  '#38bdf8', // Sky Blue
  '#818cf8', // Indigo
  '#34d399', // Emerald
  '#f472b6', // Pink
  '#fbbf24', // Amber
  '#a78bfa', // Purple
  '#4ade80', // Green
  '#f87171'  // Coral
];

// ==========================================================================
// 1. MindmapEngine: Parser, Serializer, Filtro Dettaglio & Multi-Layout
// ==========================================================================

class MindmapEngine {
  static genId() {
    return 'node_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Analizza Markdown e costruisce l'albero AST
   */
  static parseMarkdown(mdText, fallbackTitle = 'Mappa Concettuale') {
    if (!mdText || !mdText.trim()) {
      return {
        id: 'root',
        text: fallbackTitle,
        depth: 0,
        type: 'heading',
        children: [],
        collapsed: false,
        isRoot: true
      };
    }

    let content = mdText;
    let frontmatter = null;
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (fmMatch) {
      frontmatter = fmMatch[1];
      content = content.slice(fmMatch[0].length);
    }

    const lines = content.split(/\r?\n/);
    const rootNode = {
      id: 'root',
      text: fallbackTitle,
      depth: 0,
      type: 'heading',
      children: [],
      collapsed: false,
      isRoot: true,
      frontmatter
    };

    let currentParentStack = [rootNode];
    let foundFirstHeading = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Link PDF: [[Documento.pdf#page=5&rect=x,y,w,h|Testo]]
      let pdfLink = null;
      const pdfMatch = trimmed.match(/\[\[([^#\]]+\.pdf)(?:#page=(\d+)(?:&rect=([0-9.,]+))?)?(?:\|([^\]]+))?\]\]/i);
      if (pdfMatch) {
        pdfLink = {
          file: pdfMatch[1].trim(),
          page: pdfMatch[2] ? parseInt(pdfMatch[2], 10) : 1,
          rect: pdfMatch[3] ? pdfMatch[3].split(',').map(Number) : null,
          quote: pdfMatch[4] || ''
        };
      }

      // Check Heading (# H1, ## H2, ### H3...)
      const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        const text = hMatch[2].trim();

        if (!foundFirstHeading && level === 1) {
          rootNode.text = text;
          foundFirstHeading = true;
          currentParentStack = [rootNode];
          continue;
        }
        foundFirstHeading = true;

        const node = {
          id: MindmapEngine.genId(),
          text,
          depth: level,
          type: 'heading',
          children: [],
          collapsed: false,
          pdfLink,
          bodyText: ''
        };

        while (currentParentStack.length > 1 && currentParentStack[currentParentStack.length - 1].depth >= level) {
          currentParentStack.pop();
        }

        const parent = currentParentStack[currentParentStack.length - 1];
        parent.children.push(node);
        currentParentStack.push(node);
        continue;
      }

      // Check List Item (- item, * item, + item, 1. item) -> Punti chiave
      const listMatch = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        const indent = listMatch[1].replace(/\t/g, '  ').length;
        const listLevel = (currentParentStack[currentParentStack.length - 1].depth || 1) + Math.floor(indent / 2) + 1;
        const text = listMatch[2].trim();

        const node = {
          id: MindmapEngine.genId(),
          text,
          depth: listLevel,
          type: 'keypoint',
          children: [],
          collapsed: false,
          pdfLink,
          bodyText: ''
        };

        while (currentParentStack.length > 1 && currentParentStack[currentParentStack.length - 1].depth >= listLevel) {
          currentParentStack.pop();
        }

        const parent = currentParentStack[currentParentStack.length - 1];
        parent.children.push(node);
        currentParentStack.push(node);
        continue;
      }

      // Testo normale di paragrafo (approfondimento del nodo genitore)
      if (currentParentStack.length > 1) {
        const lastNode = currentParentStack[currentParentStack.length - 1];
        if (lastNode && !lastNode.isRoot) {
          lastNode.bodyText = (lastNode.bodyText ? lastNode.bodyText + '\n' : '') + trimmed;
        }
      }
    }

    return rootNode;
  }

  /**
   * Filtra l'albero in base al livello di dettaglio richiesto dall'utente
   * @param {'titles' | 'keypoints' | 'full'} level
   */
  static filterTreeByDetail(node, level = 'keypoints') {
    const clone = {
      ...node,
      children: []
    };

    if (node.children && node.children.length) {
      for (const child of node.children) {
        if (level === 'titles' && child.type !== 'heading') {
          continue; // Mostra solo i titoli H1..H6
        }
        // In keypoints o full include anche i punti elenco
        clone.children.push(MindmapEngine.filterTreeByDetail(child, level));
      }
    }

    return clone;
  }

  /**
   * Converte l'albero in Markdown pulito preservando la gerarchia
   */
  static serializeToMarkdown(rootNode, originalFm = '') {
    const lines = [];

    if (originalFm) {
      lines.push('---');
      lines.push(originalFm.trim());
      lines.push('---');
      lines.push('');
    } else {
      lines.push('---');
      lines.push('mindmap-plugin: basic');
      lines.push('tags: ["mindmap"]');
      lines.push('---');
      lines.push('');
    }

    lines.push(`# ${rootNode.text || 'Mappa Concettuale'}`);
    lines.push('');

    const walk = (node, depth) => {
      if (!node.children || !node.children.length) return;

      for (const child of node.children) {
        let nodeText = child.text || 'Nuovo Concetto';

        if (child.pdfLink && !nodeText.includes('.pdf')) {
          const p = child.pdfLink;
          const rectStr = p.rect ? `&rect=${p.rect.join(',')}` : '';
          nodeText += ` [[${p.file}#page=${p.page}${rectStr}|📄 Pag. ${p.page}]]`;
        }

        if (child.type === 'heading' || depth <= 3) {
          const hashes = '#'.repeat(Math.min(6, depth + 1));
          lines.push(`${hashes} ${nodeText}`);
        } else {
          const indent = '  '.repeat(Math.max(0, depth - 4));
          lines.push(`${indent}- ${nodeText}`);
        }

        if (child.bodyText) {
          lines.push(child.bodyText);
        }
        lines.push('');

        if (child.children && child.children.length) {
          walk(child, depth + 1);
        }
      }
    };

    walk(rootNode, 1);
    return lines.join('\n');
  }

  /**
   * Calcola le dimensioni di ogni nodo in base al testo e al dettaglio
   */
  static measureNode(node, detailLevel = 'keypoints') {
    const text = node.text || '';
    const lines = text.split('\n');
    const maxLineLen = lines.reduce((max, l) => Math.max(max, l.length), 0);

    let w = Math.max(100, Math.min(300, maxLineLen * 8.6 + 32));
    let h = Math.max(38, lines.length * 20 + 16);

    if (detailLevel === 'full' && node.bodyText) {
      w = Math.max(w, 240);
      h += Math.min(80, node.bodyText.length * 0.5 + 20);
    }

    if (node.pdfLink) {
      h += 22;
      w = Math.max(w, 160);
    }

    if (node.isRoot) {
      w = Math.max(140, maxLineLen * 10 + 44);
      h = Math.max(52, lines.length * 24 + 22);
    }

    node.width = w;
    node.height = h;

    if (node.children && node.children.length && !node.collapsed) {
      for (const child of node.children) {
        MindmapEngine.measureNode(child, detailLevel);
      }
    }
  }

  /**
   * Calcola l'altezza di un sotto-albero
   */
  static computeSubtreeHeight(node, verticalGap = 16) {
    if (!node.children || !node.children.length || node.collapsed) {
      node.subtreeHeight = node.height + verticalGap;
      return node.subtreeHeight;
    }
    let sum = 0;
    for (const child of node.children) {
      sum += MindmapEngine.computeSubtreeHeight(child, verticalGap);
    }
    node.subtreeHeight = Math.max(node.height + verticalGap, sum);
    return node.subtreeHeight;
  }

  /**
   * LAYOUT 1: MAPPA BILATERALE (Organica, rami a sinistra e destra)
   */
  static computeBilateralLayout(rootNode, options = {}) {
    const horizontalGap = options.horizontalGap || 70;
    const verticalGap = options.verticalGap || 16;
    const detailLevel = options.detailLevel || 'keypoints';

    MindmapEngine.measureNode(rootNode, detailLevel);

    const children = rootNode.children || [];
    const rightChildren = [];
    const leftChildren = [];

    // Distribuzione bilanciata destra/sinistra
    for (let i = 0; i < children.length; i++) {
      if (children[i].manualSide === 'left') {
        leftChildren.push(children[i]);
      } else if (children[i].manualSide === 'right') {
        rightChildren.push(children[i]);
      } else {
        // Alterna per bilanciare i rami
        if (i % 2 === 0) rightChildren.push(children[i]);
        else leftChildren.push(children[i]);
      }
    }

    // Calcola altezze
    let rightHeight = 0;
    rightChildren.forEach(c => rightHeight += MindmapEngine.computeSubtreeHeight(c, verticalGap));
    let leftHeight = 0;
    leftChildren.forEach(c => leftHeight += MindmapEngine.computeSubtreeHeight(c, verticalGap));

    const maxSideHeight = Math.max(rightHeight, leftHeight, 400);

    // Centro della radice
    rootNode.x = 900;
    rootNode.y = Math.max(260, maxSideHeight / 2);
    rootNode.color = '#38bdf8';
    rootNode.direction = 'center';

    const renderedNodes = [rootNode];
    const branchPaths = [];

    // 1. Ramo Destro
    let curY = rootNode.y + (rootNode.height / 2) - (rightHeight / 2);
    for (let i = 0; i < rightChildren.length; i++) {
      const child = rightChildren[i];
      const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
      child.color = color;
      child.direction = 'right';

      child.x = rootNode.x + rootNode.width + horizontalGap;
      child.y = curY + (child.subtreeHeight / 2) - (child.height / 2);
      curY += child.subtreeHeight;

      renderedNodes.push(child);

      const x1 = rootNode.x + rootNode.width;
      const y1 = rootNode.y + (rootNode.height / 2);
      const x2 = child.x;
      const y2 = child.y + (child.height / 2);
      const dx = (x2 - x1) * 0.55;

      branchPaths.push({
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        color,
        fromId: rootNode.id,
        toId: child.id
      });

      MindmapEngine.positionSubChildren(child, color, 'right', horizontalGap, renderedNodes, branchPaths);
    }

    // 2. Ramo Sinistro
    curY = rootNode.y + (rootNode.height / 2) - (leftHeight / 2);
    for (let i = 0; i < leftChildren.length; i++) {
      const child = leftChildren[i];
      const color = BRANCH_COLORS[(i + 4) % BRANCH_COLORS.length];
      child.color = color;
      child.direction = 'left';

      child.x = rootNode.x - child.width - horizontalGap;
      child.y = curY + (child.subtreeHeight / 2) - (child.height / 2);
      curY += child.subtreeHeight;

      renderedNodes.push(child);

      const x1 = rootNode.x;
      const y1 = rootNode.y + (rootNode.height / 2);
      const x2 = child.x + child.width;
      const y2 = child.y + (child.height / 2);
      const dx = (x1 - x2) * 0.55;

      branchPaths.push({
        d: `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`,
        color,
        fromId: rootNode.id,
        toId: child.id
      });

      MindmapEngine.positionSubChildren(child, color, 'left', horizontalGap, renderedNodes, branchPaths);
    }

    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }

  static positionSubChildren(parent, color, direction, horizontalGap, renderedNodes, branchPaths) {
    if (!parent.children || !parent.children.length || parent.collapsed) return;

    let startY = parent.y + (parent.height / 2) - (parent.subtreeHeight / 2);

    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i];
      child.color = color;
      child.direction = direction;

      if (direction === 'right') {
        child.x = parent.x + parent.width + horizontalGap;
        child.y = startY + (child.subtreeHeight / 2) - (child.height / 2);
        startY += child.subtreeHeight;

        renderedNodes.push(child);

        const x1 = parent.x + parent.width;
        const y1 = parent.y + (parent.height / 2);
        const x2 = child.x;
        const y2 = child.y + (child.height / 2);
        const dx = (x2 - x1) * 0.55;

        branchPaths.push({
          d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
          color,
          fromId: parent.id,
          toId: child.id
        });
      } else {
        child.x = parent.x - child.width - horizontalGap;
        child.y = startY + (child.subtreeHeight / 2) - (child.height / 2);
        startY += child.subtreeHeight;

        renderedNodes.push(child);

        const x1 = parent.x;
        const y1 = parent.y + (parent.height / 2);
        const x2 = child.x + child.width;
        const y2 = child.y + (child.height / 2);
        const dx = (x1 - x2) * 0.55;

        branchPaths.push({
          d: `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`,
          color,
          fromId: parent.id,
          toId: child.id
        });
      }

      MindmapEngine.positionSubChildren(child, color, direction, horizontalGap, renderedNodes, branchPaths);
    }
  }

  /**
   * LAYOUT 2: STRUTTURA A DESTRA (Compatta)
   */
  static computeRightLayout(rootNode, options = {}) {
    const horizontalGap = options.horizontalGap || 70;
    const verticalGap = options.verticalGap || 16;
    const detailLevel = options.detailLevel || 'keypoints';

    MindmapEngine.measureNode(rootNode, detailLevel);
    MindmapEngine.computeSubtreeHeight(rootNode, verticalGap);

    rootNode.x = 80;
    rootNode.y = Math.max(200, (rootNode.subtreeHeight - rootNode.height) / 2);
    rootNode.color = '#38bdf8';
    rootNode.direction = 'right';

    const renderedNodes = [rootNode];
    const branchPaths = [];

    if (rootNode.children && rootNode.children.length && !rootNode.collapsed) {
      let curY = rootNode.y + (rootNode.height / 2) - (rootNode.subtreeHeight / 2);

      for (let i = 0; i < rootNode.children.length; i++) {
        const child = rootNode.children[i];
        const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
        child.color = color;
        child.direction = 'right';

        child.x = rootNode.x + rootNode.width + horizontalGap;
        child.y = curY + (child.subtreeHeight / 2) - (child.height / 2);
        curY += child.subtreeHeight;

        renderedNodes.push(child);

        const x1 = rootNode.x + rootNode.width;
        const y1 = rootNode.y + (rootNode.height / 2);
        const x2 = child.x;
        const y2 = child.y + (child.height / 2);
        const dx = (x2 - x1) * 0.55;

        branchPaths.push({
          d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
          color,
          fromId: rootNode.id,
          toId: child.id
        });

        MindmapEngine.positionSubChildren(child, color, 'right', horizontalGap, renderedNodes, branchPaths);
      }
    }

    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }
}

// ==========================================================================
// 2. MindmapCanvas: Controller con Dock Superiore e Viste Multiple
// ==========================================================================

class MindmapCanvas {
  constructor(containerEl, options = {}) {
    this.container = containerEl;
    this.options = options;
    this.rawRootNode = options.rootNode || { id: 'root', text: 'Mappa Concettuale', children: [], isRoot: true };
    this.selectedNodeId = 'root';
    this.viewMode = options.viewMode || 'bilateral'; // 'bilateral' | 'right' | 'table' | 'outline'
    this.detailLevel = options.detailLevel || 'keypoints'; // 'titles' | 'keypoints' | 'full'

    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.isDraggingCanvas = false;
    this.dragStart = { x: 0, y: 0 };
    this.expandedNodes = new Set();

    this.initDOM();
    this.render();
  }

  initDOM() {
    this.container.empty();
    this.container.addClass('cds-mm-container');

    // 1. DOCK SUPERIORE UNIFICATO (Nessun elemento in basso!)
    this.topDock = this.container.createDiv({ cls: 'cds-mm-top-dock' });
    this.renderTopDock();

    // 2. VIEWPORT PER IL CANVAS
    this.viewport = this.container.createDiv({ cls: 'cds-mm-viewport' });
    this.stage = this.viewport.createDiv({ cls: 'cds-mm-stage' });

    this.svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svgLayer.setAttribute('class', 'cds-mm-svg');
    this.stage.appendChild(this.svgLayer);

    this.nodesLayer = this.stage.createDiv({ cls: 'cds-mm-nodes-layer' });

    // 3. CONTENITORI PER VISTE TABELLA E OUTLINE
    this.tableContainer = this.container.createDiv({ cls: 'cds-mm-table-container' });
    this.tableContainer.style.display = 'none';

    this.outlineContainer = this.container.createDiv({ cls: 'cds-mm-outline-container' });
    this.outlineContainer.style.display = 'none';

    // Eventi Pan & Zoom
    this.viewport.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Scorciatoie Tastiera
    this.container.setAttribute('tabindex', '0');
    this.container.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  renderTopDock() {
    this.topDock.empty();

    // GRUPPO 1: VISTE MULTIPLE
    const groupViews = this.topDock.createDiv({ cls: 'cds-mm-dock-group' });
    groupViews.createSpan({ text: 'Vista:', cls: 'cds-mm-dock-label' });

    const mkViewBtn = (id, label, icon) => {
      const b = groupViews.createEl('button', {
        cls: 'cds-mm-dock-btn' + (this.viewMode === id ? ' is-active' : ''),
        attr: { title: `Passa a vista ${label}` }
      });
      b.innerHTML = `${icon} <span>${label}</span>`;
      b.onclick = () => {
        this.viewMode = id;
        this.renderTopDock();
        this.render();
      };
      return b;
    };

    mkViewBtn('bilateral', 'Bilaterale', '🧠');
    mkViewBtn('right', 'A Destra', '🌿');
    mkViewBtn('table', 'Tabella', '📊');
    mkViewBtn('outline', 'Outline', '📑');

    // GRUPPO 2: LIVELLO DI DETTAGLIO
    const groupDetail = this.topDock.createDiv({ cls: 'cds-mm-dock-group' });
    groupDetail.createSpan({ text: 'Dettaglio:', cls: 'cds-mm-dock-label' });

    const mkDetailBtn = (lvl, label, icon, tip) => {
      const b = groupDetail.createEl('button', {
        cls: 'cds-mm-dock-btn' + (this.detailLevel === lvl ? ' is-active' : ''),
        attr: { title: tip }
      });
      b.innerHTML = `${icon} <span>${label}</span>`;
      b.onclick = () => {
        this.detailLevel = lvl;
        this.renderTopDock();
        this.render();
      };
      return b;
    };

    mkDetailBtn('titles', 'Solo Titoli', '🏷️', 'Mostra solo la gerarchia H1/H2/H3');
    mkDetailBtn('keypoints', 'Punti Chiave', '🎯', 'Mostra titoli e concetti principali');
    mkDetailBtn('full', 'Tutto', '📖', 'Mostra anche il testo completo dei paragrafi');

    // GRUPPO 3: STRUMENTI OPERATIVI
    const groupTools = this.topDock.createDiv({ cls: 'cds-mm-dock-group' });

    const mkToolBtn = (icon, tip, onClick) => {
      const b = groupTools.createEl('button', { cls: 'cds-mm-dock-btn', attr: { title: tip } });
      b.innerHTML = icon;
      b.onclick = onClick;
      return b;
    };

    mkToolBtn('➕ Figlio', 'Aggiungi Nodo Figlio (Tab)', () => this.addChildToSelected());
    mkToolBtn('⏬ Fratello', 'Aggiungi Nodo Fratello (Enter)', () => this.addSiblingToSelected());
    mkToolBtn('🗑️', 'Elimina Nodo (Canc)', () => this.deleteSelected());

    groupTools.createDiv({ cls: 'cds-mm-divider' });

    mkToolBtn('🔍+', 'Zoom In', () => this.setZoom(this.zoom * 1.15));
    mkToolBtn('🔍−', 'Zoom Out', () => this.setZoom(this.zoom / 1.15));
    mkToolBtn('100%', 'Reset Zoom', () => { this.zoom = 1; this.updateTransform(); });
    mkToolBtn('🧭 Centra', 'Centra Mappa (Ctrl+E)', () => this.centerRoot());

    groupTools.createDiv({ cls: 'cds-mm-divider' });

    mkToolBtn('🖼️ SVG', 'Esporta Immagine SVG', () => this.exportSVG());
    mkToolBtn('📷 PNG', 'Esporta Immagine PNG', () => this.exportPNG());
  }

  render() {
    // 1. Modalità Tabella
    if (this.viewMode === 'table') {
      this.viewport.style.display = 'none';
      this.outlineContainer.style.display = 'none';
      this.tableContainer.style.display = 'block';
      this.renderTableView();
      return;
    }

    // 2. Modalità Outline
    if (this.viewMode === 'outline') {
      this.viewport.style.display = 'none';
      this.tableContainer.style.display = 'none';
      this.outlineContainer.style.display = 'block';
      this.renderOutlineView();
      return;
    }

    // 3. Modalità Canvas (Bilaterale o A Destra)
    this.tableContainer.style.display = 'none';
    this.outlineContainer.style.display = 'none';
    this.viewport.style.display = 'block';

    const activeTree = MindmapEngine.filterTreeByDetail(this.rawRootNode, this.detailLevel);

    let layout;
    if (this.viewMode === 'bilateral') {
      layout = MindmapEngine.computeBilateralLayout(activeTree, { detailLevel: this.detailLevel });
    } else {
      layout = MindmapEngine.computeRightLayout(activeTree, { detailLevel: this.detailLevel });
    }

    this.renderedNodes = layout.nodes;
    this.renderedPaths = layout.paths;

    // Svuota e disegna percorsi SVG
    while (this.svgLayer.firstChild) {
      this.svgLayer.removeChild(this.svgLayer.firstChild);
    }

    let minX = 0, minY = 0, maxX = 1800, maxY = 1200;

    for (const p of this.renderedPaths) {
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', p.d);
      pathEl.setAttribute('stroke', p.color);
      pathEl.setAttribute('class', 'cds-mm-branch-path' + (p.toId === this.selectedNodeId ? ' is-selected' : ''));
      this.svgLayer.appendChild(pathEl);
    }

    // Disegna Nodi HTML
    this.nodesLayer.empty();

    for (const node of this.renderedNodes) {
      if (node.x + node.width > maxX) maxX = node.x + node.width + 100;
      if (node.y + node.height > maxY) maxY = node.y + node.height + 100;

      const nodeEl = this.nodesLayer.createDiv({
        cls: 'cds-mm-node' +
          (node.isRoot ? ' is-root' : ` level-${node.depth}`) +
          (node.id === this.selectedNodeId ? ' is-selected' : '') +
          (node.direction === 'left' ? ' is-left' : ' is-right')
      });

      nodeEl.style.left = `${node.x}px`;
      nodeEl.style.top = `${node.y}px`;
      nodeEl.style.width = `${node.width}px`;
      nodeEl.style.borderColor = node.isRoot ? 'rgba(255,255,255,0.4)' : node.color || '#38bdf8';

      // Titolo/Testo principale
      const titleEl = nodeEl.createDiv({ cls: 'cds-mm-node-title' });
      titleEl.textContent = node.text;

      // Se livello completo o c'è testo corpo
      if (node.bodyText) {
        if (this.detailLevel === 'full' || this.expandedNodes.has(node.id)) {
          const bodyEl = nodeEl.createDiv({ cls: 'cds-mm-node-body' });
          bodyEl.textContent = node.bodyText;
        } else if (this.detailLevel === 'keypoints') {
          const toggle = nodeEl.createDiv({ cls: 'cds-mm-expand-toggle' });
          toggle.textContent = '… Dettagli';
          toggle.onclick = (ev) => {
            ev.stopPropagation();
            this.expandedNodes.add(node.id);
            this.render();
          };
        }
      }

      // Badge Link PDF se presente
      if (node.pdfLink) {
        const badge = nodeEl.createDiv({ cls: 'cds-mm-pdf-badge' });
        badge.innerHTML = `📄 <b>${node.pdfLink.file}</b> · Pag. ${node.pdfLink.page}`;
        badge.onclick = (ev) => {
          ev.stopPropagation();
          if (this.options.onPdfJump) {
            this.options.onPdfJump(node.pdfLink);
          }
        };
      }

      // Pulsante Espandi/Riduci se ha figli
      if (node.children && node.children.length) {
        const foldBtn = nodeEl.createDiv({
          cls: 'cds-mm-fold-btn' + (node.collapsed ? ' is-collapsed' : '')
        });
        foldBtn.textContent = node.collapsed ? `+${node.children.length}` : '−';
        foldBtn.onclick = (ev) => {
          ev.stopPropagation();
          // Trova il nodo corrispondente nell'albero originale
          const raw = this.findRawNode(node.id);
          if (raw) raw.collapsed = !raw.collapsed;
          node.collapsed = !node.collapsed;
          this.render();
          this.triggerSave();
        };
      }

      // Pulsante Rapido Aggiungi Figlio (+) al passaggio del mouse
      const addBtn = nodeEl.createDiv({ cls: 'cds-mm-add-btn', attr: { title: 'Aggiungi nodo figlio' } });
      addBtn.textContent = '+';
      addBtn.onclick = (ev) => {
        ev.stopPropagation();
        this.selectedNodeId = node.id;
        this.addChildToSelected();
      };

      // Click e Drag & Drop
      nodeEl.onmousedown = (ev) => {
        ev.stopPropagation();
        this.selectNode(node.id);
        if (ev.button === 0 && !node.isRoot) {
          this.startNodeDrag(node, ev);
        }
      };

      nodeEl.ondblclick = (ev) => {
        ev.stopPropagation();
        this.startEditing(node, nodeEl);
      };
    }

    this.svgLayer.setAttribute('width', `${maxX + 400}`);
    this.svgLayer.setAttribute('height', `${maxY + 400}`);
    this.stage.style.width = `${maxX + 400}px`;
    this.stage.style.height = `${maxY + 400}px`;

    this.updateTransform();
  }

  /**
   * VISTA TABELLA / MATRICE CONCETTUALE
   */
  renderTableView() {
    this.tableContainer.empty();
    const table = this.tableContainer.createEl('table', { cls: 'cds-mm-table' });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    ['Macro-Capitolo (H1/H2)', 'Sezione / Argomento (H3)', 'Punti Chiave & Elenco', 'Citazioni PDF & Note'].forEach(h => {
      headerRow.createEl('th', { text: h });
    });

    const tbody = table.createEl('tbody');
    const chapters = this.rawRootNode.children || [];

    if (!chapters.length) {
      const row = tbody.createEl('tr');
      row.createEl('td', { text: 'Nessun capitolo presente. Aggiungi sezioni per popolare la tabella.', attr: { colspan: 4, style: 'text-align:center;color:#94a3b8;padding:24px;' } });
      return;
    }

    for (const chap of chapters) {
      const sections = chap.children && chap.children.length ? chap.children : [{ text: '—', children: [] }];

      for (let sIdx = 0; sIdx < sections.length; sIdx++) {
        const sec = sections[sIdx];
        const keypoints = sec.children && sec.children.length ? sec.children : [{ text: '—' }];

        for (let kIdx = 0; kIdx < keypoints.length; kIdx++) {
          const kp = keypoints[kIdx];
          const tr = tbody.createEl('tr');

          // Cella Capitolo
          if (sIdx === 0 && kIdx === 0) {
            const tdChap = tr.createEl('td', { attr: { rowspan: sections.reduce((acc, s) => acc + (s.children && s.children.length ? s.children.length : 1), 0) } });
            tdChap.style.fontWeight = '700';
            tdChap.style.color = '#38bdf8';
            const cell = tdChap.createDiv({ cls: 'cds-mm-table-cell', text: chap.text });
            cell.contentEditable = 'true';
            cell.onblur = () => { chap.text = cell.textContent.trim(); this.triggerSave(); };
          }

          // Cella Sezione
          if (kIdx === 0) {
            const tdSec = tr.createEl('td', { attr: { rowspan: kp ? (sec.children && sec.children.length ? sec.children.length : 1) : 1 } });
            tdSec.style.fontWeight = '600';
            const cell = tdSec.createDiv({ cls: 'cds-mm-table-cell', text: sec.text });
            cell.contentEditable = 'true';
            cell.onblur = () => { sec.text = cell.textContent.trim(); this.triggerSave(); };
          }

          // Cella Punto Chiave
          const tdKp = tr.createEl('td');
          const cellKp = tdKp.createDiv({ cls: 'cds-mm-table-cell', text: kp.text });
          cellKp.contentEditable = 'true';
          cellKp.onblur = () => { kp.text = cellKp.textContent.trim(); this.triggerSave(); };

          // Cella Note & Link PDF
          const tdNote = tr.createEl('td');
          if (kp.pdfLink) {
            const b = tdNote.createDiv({ cls: 'cds-mm-pdf-badge' });
            b.innerHTML = `📄 ${kp.pdfLink.file} (Pag. ${kp.pdfLink.page})`;
            b.onclick = () => { if (this.options.onPdfJump) this.options.onPdfJump(kp.pdfLink); };
          }
          if (kp.bodyText) {
            tdNote.createEl('div', { text: kp.bodyText, attr: { style: 'font-size:.78rem;color:#94a3b8;margin-top:4px;' } });
          }
        }
      }
    }
  }

  /**
   * VISTA OUTLINE GERARCHICA
   */
  renderOutlineView() {
    this.outlineContainer.empty();
    const title = this.outlineContainer.createEl('h2', { text: this.rawRootNode.text || 'Outline', attr: { style: 'color:#38bdf8;margin-bottom:18px;' } });

    const walk = (node, container, level) => {
      if (!node.children || !node.children.length) return;

      for (const child of node.children) {
        const item = container.createDiv({ cls: 'cds-mm-outline-item' });
        item.style.paddingLeft = `${level * 22}px`;

        const bullet = item.createDiv({ cls: 'cds-mm-outline-bullet' });
        bullet.style.background = BRANCH_COLORS[level % BRANCH_COLORS.length];

        const textSpan = item.createDiv({ cls: 'cds-mm-outline-text', text: child.text });
        textSpan.contentEditable = 'true';
        textSpan.onblur = () => {
          child.text = textSpan.textContent.trim();
          this.triggerSave();
        };

        if (child.pdfLink) {
          const b = item.createDiv({ cls: 'cds-mm-pdf-badge' });
          b.innerHTML = `📄 Pag. ${child.pdfLink.page}`;
          b.onclick = () => { if (this.options.onPdfJump) this.options.onPdfJump(child.pdfLink); };
        }

        if (child.children && child.children.length) {
          walk(child, container, level + 1);
        }
      }
    };

    walk(this.rawRootNode, this.outlineContainer, 0);
  }

  updateTransform() {
    this.stage.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  setZoom(val) {
    this.zoom = Math.max(0.25, Math.min(3.0, val));
    this.updateTransform();
  }

  centerRoot() {
    const vW = this.viewport.clientWidth || 1000;
    const vH = this.viewport.clientHeight || 700;

    if (this.viewMode === 'bilateral') {
      this.panX = (vW / 2) - 900 - (this.rawRootNode.width / 2);
      this.panY = (vH / 2) - 260 - (this.rawRootNode.height / 2);
    } else {
      this.panX = Math.max(60, vW * 0.1);
      this.panY = Math.max(60, (vH / 2) - 150);
    }
    this.zoom = 1;
    this.updateTransform();
  }

  selectNode(nodeId) {
    this.selectedNodeId = nodeId;
    this.render();
  }

  findRawNode(nodeId, node = this.rawRootNode) {
    if (node.id === nodeId) return node;
    if (node.children) {
      for (const child of node.children) {
        const res = this.findRawNode(nodeId, child);
        if (res) return res;
      }
    }
    return null;
  }

  findParent(nodeId, current = this.rawRootNode) {
    if (!current.children) return null;
    for (const child of current.children) {
      if (child.id === nodeId) return current;
      const res = this.findParent(nodeId, child);
      if (res) return res;
    }
    return null;
  }

  addChildToSelected(defaultText = 'Nuovo Concetto', pdfLink = null) {
    const parent = this.findRawNode(this.selectedNodeId) || this.rawRootNode;
    parent.collapsed = false;
    const newNode = {
      id: MindmapEngine.genId(),
      text: defaultText,
      depth: (parent.depth || 0) + 1,
      type: parent.depth === 0 ? 'heading' : 'keypoint',
      children: [],
      collapsed: false,
      pdfLink,
      bodyText: ''
    };
    parent.children.push(newNode);
    this.selectedNodeId = newNode.id;
    this.render();
    this.triggerSave();

    setTimeout(() => {
      const nodeEl = this.nodesLayer.querySelector('.cds-mm-node.is-selected');
      if (nodeEl) this.startEditing(newNode, nodeEl);
    }, 50);
  }

  addSiblingToSelected(defaultText = 'Nuovo Ramo') {
    if (this.selectedNodeId === 'root') {
      this.addChildToSelected(defaultText);
      return;
    }
    const parent = this.findParent(this.selectedNodeId);
    if (!parent) return;

    const idx = parent.children.findIndex(c => c.id === this.selectedNodeId);
    const newNode = {
      id: MindmapEngine.genId(),
      text: defaultText,
      depth: parent.depth + 1,
      type: parent.depth === 0 ? 'heading' : 'keypoint',
      children: [],
      collapsed: false,
      bodyText: ''
    };

    parent.children.splice(idx + 1, 0, newNode);
    this.selectedNodeId = newNode.id;
    this.render();
    this.triggerSave();

    setTimeout(() => {
      const nodeEl = this.nodesLayer.querySelector('.cds-mm-node.is-selected');
      if (nodeEl) this.startEditing(newNode, nodeEl);
    }, 50);
  }

  deleteSelected() {
    if (this.selectedNodeId === 'root') {
      new Notice('La radice della mappa non può essere eliminata.');
      return;
    }
    const parent = this.findParent(this.selectedNodeId);
    if (!parent) return;

    const idx = parent.children.findIndex(c => c.id === this.selectedNodeId);
    if (idx !== -1) {
      parent.children.splice(idx, 1);
      this.selectedNodeId = parent.id;
      this.render();
      this.triggerSave();
    }
  }

  startEditing(node, nodeEl) {
    if (this.editingInput) return;

    const input = document.createElement('textarea');
    input.className = 'cds-mm-editor-input';
    input.value = node.text;
    input.style.left = `${node.x}px`;
    input.style.top = `${node.y}px`;
    input.style.width = `${Math.max(node.width, 180)}px`;
    input.style.height = `${Math.max(node.height, 50)}px`;

    this.nodesLayer.appendChild(input);
    input.focus();
    input.select();
    this.editingInput = input;

    const commit = () => {
      if (!this.editingInput) return;
      const val = input.value.trim();
      if (val) {
        node.text = val;
        const raw = this.findRawNode(node.id);
        if (raw) raw.text = val;
      }
      this.nodesLayer.removeChild(input);
      this.editingInput = null;
      this.render();
      this.triggerSave();
    };

    input.onblur = commit;
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        this.nodesLayer.removeChild(input);
        this.editingInput = null;
        this.render();
      }
    };
  }

  onKeyDown(e) {
    if (this.editingInput) return;

    if (e.key === 'Tab') {
      e.preventDefault();
      this.addChildToSelected();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.addSiblingToSelected();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.deleteSelected();
    } else if (e.key === 'F2' || e.key === ' ') {
      e.preventDefault();
      const node = this.findRawNode(this.selectedNodeId);
      const nodeEl = this.nodesLayer.querySelector('.cds-mm-node.is-selected');
      if (node && nodeEl) this.startEditing(node, nodeEl);
    } else if (e.key === 'e' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.centerRoot();
    }
  }

  onMouseDown(e) {
    if (e.target.closest('.cds-mm-node') || e.target.closest('.cds-mm-top-dock')) return;
    this.isDraggingCanvas = true;
    this.viewport.addClass('is-dragging');
    this.dragStart = { x: e.clientX - this.panX, y: e.clientY - this.panY };
  }

  onMouseMove(e) {
    if (this.isDraggingCanvas) {
      this.panX = e.clientX - this.dragStart.x;
      this.panY = e.clientY - this.dragStart.y;
      this.updateTransform();
    }
  }

  onMouseUp() {
    if (this.isDraggingCanvas) {
      this.isDraggingCanvas = false;
      this.viewport.removeClass('is-dragging');
    }
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const delta = e.deltaY < 0 ? 1.1 : 0.9;
      this.setZoom(this.zoom * delta);
    } else {
      this.panX -= e.deltaX * 0.8;
      this.panY -= e.deltaY * 0.8;
      this.updateTransform();
    }
  }

  /**
   * SPOSTAMENTO LIBERO DEI CAPITOLI E DEI NODI (Drag & Drop)
   */
  startNodeDrag(node, ev) {
    const ghost = ev.target.closest('.cds-mm-node');
    if (!ghost) return;

    ghost.addClass('is-ghost');
    let targetNode = null;
    const startX = ev.clientX;

    const onMove = (me) => {
      const els = document.elementsFromPoint(me.clientX, me.clientY);
      const hoverNodeEl = els.find(el => el.classList && el.classList.contains('cds-mm-node') && el !== ghost);
      if (hoverNodeEl) {
        document.querySelectorAll('.cds-mm-node.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
        hoverNodeEl.classList.add('is-drop-target');
        targetNode = this.renderedNodes.find(n => hoverNodeEl.textContent.includes(n.text));
      }
    };

    const onUp = (ue) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      ghost.removeClass('is-ghost');
      document.querySelectorAll('.cds-mm-node.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));

      const rawNode = this.findRawNode(node.id);
      if (!rawNode) return;

      // 1. Se stiamo trascinando un capitolo principale in vista bilaterale:
      // controlla se è stato trascinato a sinistra o destra della radice per invertire il lato
      if (node.depth === 1 && this.viewMode === 'bilateral') {
        const deltaX = ue.clientX - startX;
        if (deltaX < -150 && rawNode.manualSide !== 'left') {
          rawNode.manualSide = 'left';
          new Notice(`Spostato capitolo "${rawNode.text.slice(0, 20)}" a SINISTRA`);
          this.render();
          this.triggerSave();
          return;
        } else if (deltaX > 150 && rawNode.manualSide !== 'right') {
          rawNode.manualSide = 'right';
          new Notice(`Spostato capitolo "${rawNode.text.slice(0, 20)}" a DESTRA`);
          this.render();
          this.triggerSave();
          return;
        }
      }

      // 2. Se trascinato sopra un altro nodo: reparenting o riordino
      if (targetNode && targetNode.id !== node.id) {
        const oldParent = this.findParent(node.id);
        const newParent = this.findRawNode(targetNode.id);

        if (oldParent && newParent && oldParent.id !== newParent.id) {
          oldParent.children = oldParent.children.filter(c => c.id !== node.id);
          rawNode.depth = newParent.depth + 1;
          newParent.children.push(rawNode);
          newParent.collapsed = false;
          this.render();
          this.triggerSave();
          newNotice(`Spostato "${rawNode.text.slice(0, 20)}" sotto "${newParent.text.slice(0, 20)}"`);
        }
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  triggerSave() {
    if (this.options.onSaveMarkdown) {
      const md = MindmapEngine.serializeToMarkdown(this.rawRootNode, this.options.frontmatter);
      this.options.onSaveMarkdown(md);
    }
  }

  exportSVG() {
    const clone = this.svgLayer.cloneNode(true);
    clone.style.background = '#0d1117';
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(clone);
    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.rawRootNode.text || 'mindmap'}.svg`;
    a.click();
    URL.revokeObjectURL(url);
    new Notice('✅ Mappa esportata come SVG!');
  }

  exportPNG() {
    const clone = this.svgLayer.cloneNode(true);
    clone.style.background = '#0d1117';
    const svgStr = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = parseInt(this.svgLayer.getAttribute('width') || '1600', 10);
      canvas.height = parseInt(this.svgLayer.getAttribute('height') || '1000', 10);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      canvas.toBlob((blob) => {
        const pngUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = pngUrl;
        a.download = `${this.rawRootNode.text || 'mindmap'}.png`;
        a.click();
        URL.revokeObjectURL(pngUrl);
        new Notice('✅ Mappa esportata come PNG!');
      });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }
}

// ==========================================================================
// 3. CdsMindmapView: Vista Obsidian con Live Real-Time Two-Way Sync
// ==========================================================================

class CdsMindmapView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null;
    this.canvas = null;
    this._isInternalSaving = false;
    this._syncTimer = null;
  }

  getViewType() {
    return VIEW_TYPE_MINDMAP;
  }

  getDisplayText() {
    return this.file ? `Mappa: ${this.file.basename}` : 'Mappa Concettuale';
  }

  getIcon() {
    return 'git-fork';
  }

  async setFile(file) {
    this.file = file;
    await this.loadMindmapFromFile();
  }

  async loadMindmapFromFile() {
    if (!this.file) return;
    const content = await this.app.vault.read(this.file);
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const frontmatter = fmMatch ? fmMatch[1] : '';

    const rootNode = MindmapEngine.parseMarkdown(content, this.file.basename);

    this.canvas = new MindmapCanvas(this.contentEl, {
      rootNode,
      frontmatter,
      onSaveMarkdown: async (newMd) => {
        if (this.file) {
          this._isInternalSaving = true;
          clearTimeout(this._syncTimer);
          this._syncTimer = setTimeout(async () => {
            await this.app.vault.modify(this.file, newMd);
            setTimeout(() => { this._isInternalSaving = false; }, 250);
          }, 150);
        }
      },
      onPdfJump: (pdfLink) => {
        this.plugin.jumpToPdfAnnotation(pdfLink);
      }
    });

    this.canvas.centerRoot();
  }

  /**
   * Ricaricamento live in tempo reale da Markdown (mentre si scrive nella nota)
   */
  async reloadFromMarkdown() {
    if (!this.file || !this.canvas || this._isInternalSaving) return;
    const content = await this.app.vault.read(this.file);
    const newRoot = MindmapEngine.parseMarkdown(content, this.file.basename);
    this.canvas.rawRootNode = newRoot;
    this.canvas.render();
  }

  async onOpen() {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === 'md') {
      await this.setFile(activeFile);
    }
  }
}

// ==========================================================================
// 4. CdsMindmapPlugin: Lifecycle & Event Listeners Real-Time
// ==========================================================================

module.exports = class CdsMindmapPlugin extends Plugin {
  async onload() {
    console.log('Loading CDS Mindmap Suite v2');

    // 1. Registra Vista Nativa
    this.registerView(VIEW_TYPE_MINDMAP, (leaf) => new CdsMindmapView(leaf, this));

    // 2. Sincronizzazione in tempo reale mentre si scrive nelle note
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MINDMAP);
        for (const leaf of leaves) {
          const v = leaf.view;
          if (v && v.file && v.file.path === file.path && !v._isInternalSaving) {
            v.reloadFromMarkdown();
          }
        }
      })
    );

    // 3. Ribbon Icon
    this.addRibbonIcon('git-fork', 'CDS Mindmap: Apri come Mappa Concettuale', () => {
      this.openActiveNoteAsMindmap();
    });

    // 4. Comandi
    this.addCommand({
      id: 'open-active-note-as-mindmap',
      name: 'Apri nota attiva come Mappa Concettuale (Mindmap)',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === 'md') {
          if (!checking) this.openActiveNoteAsMindmap();
          return true;
        }
        return false;
      }
    });

    this.addCommand({
      id: 'create-new-mindmap',
      name: 'Crea nuova Mappa Concettuale',
      callback: async () => {
        const title = 'Nuova Mappa ' + new Date().toISOString().slice(0, 10);
        const fileName = `${title}.md`;
        const content = `---\nmindmap-plugin: basic\ntags: ["mindmap"]\n---\n\n# ${title}\n\n## Ramo 1\n- Concetto 1.1\n- Concetto 1.2\n\n## Ramo 2\n- Concetto 2.1\n\n## Ramo 3\n`;
        const file = await this.app.vault.create(fileName, content);
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.setViewState({ type: VIEW_TYPE_MINDMAP, active: true });
        const view = leaf.view;
        if (view && view.setFile) await view.setFile(file);
      }
    });

    // 5. Codeblock Processors: ```mindmap e ```markmind
    const codeblockHandler = (source, el, ctx) => {
      el.empty();
      const wrap = el.createDiv({ cls: 'cds-mm-codeblock' });
      const rootNode = MindmapEngine.parseMarkdown(source, 'Mappa Concettuale');

      new MindmapCanvas(wrap, {
        rootNode,
        onSaveMarkdown: async (newMd) => {
          const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
          if (file instanceof TFile) {
            const raw = await this.app.vault.read(file);
            const pureMd = MindmapEngine.serializeToMarkdown(rootNode).replace(/^---[\s\S]*?---\s*/, '').trim();
            const updated = raw.replace(source, pureMd);
            if (updated !== raw) {
              await this.app.vault.modify(file, updated);
            }
          }
        },
        onPdfJump: (pdfLink) => {
          this.jumpToPdfAnnotation(pdfLink);
        }
      });
    };

    this.registerMarkdownCodeBlockProcessor('mindmap', codeblockHandler);
    this.registerMarkdownCodeBlockProcessor('markmind', codeblockHandler);

    // 6. Menu File
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((item) => {
            item
              .setTitle('Apri come Mappa Concettuale (Mindmap)')
              .setIcon('git-fork')
              .onClick(() => {
                this.openFileAsMindmap(file);
              });
          });
        }
      })
    );
  }

  async openActiveNoteAsMindmap() {
    const file = this.app.workspace.getActiveFile();
    if (file) {
      await this.openFileAsMindmap(file);
    } else {
      new Notice('Nessuna nota attiva da trasformare in mappa.');
    }
  }

  async openFileAsMindmap(file) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_MINDMAP)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf('split', 'vertical');
    }
    await leaf.setViewState({ type: VIEW_TYPE_MINDMAP, active: true });
    const view = leaf.view;
    if (view && view.setFile) {
      await view.setFile(file);
    }
  }

  async jumpToPdfAnnotation(pdfLink) {
    if (!pdfLink || !pdfLink.file) return;

    const file = this.app.metadataCache.getFirstLinkpathDest(pdfLink.file, '');
    if (!file) {
      new Notice(`Documento PDF non trovato nel vault: ${pdfLink.file}`);
      return;
    }

    new Notice(`Salto a ${file.name} (Pag. ${pdfLink.page})...`);

    const docsPlugin = this.app.plugins.getPlugin('cds-docs');
    if (docsPlugin && docsPlugin.openPdfFile) {
      docsPlugin.openPdfFile(file, pdfLink.page, pdfLink.rect);
      return;
    }

    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);

    const state = leaf.getViewState();
    if (state && state.state) {
      state.state.page = pdfLink.page;
      await leaf.setViewState(state);
    }
  }

  onunload() {
    console.log('Unloading CDS Mindmap Suite v2');
  }
};
