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

// Session cache per le posizioni e layout personalizzati dei nodi per file
const CUSTOM_POSITIONS_CACHE = new Map();

// ==========================================================================
// 1. MindmapEngine: Parser, Serializer, Filtro Dettaglio & Multi-Layout
// ==========================================================================

class MindmapEngine {
  /**
   * Genera un ID deterministico stabile basato sul percorso gerarchico e testo
   */
  static generateDeterministicId(parentPath, index, text) {
    const clean = (text || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
    return parentPath ? `${parentPath}_${index}_${clean}` : 'root';
  }

  /**
   * Analizza Markdown e costruisce l'albero AST con supporto a direttive di layout e tabelle
   */
  static parseMarkdown(mdText, fallbackTitle = 'Mappa Concettuale', filePath = '') {
    if (!mdText || !mdText.trim()) {
      return {
        id: 'root',
        text: fallbackTitle,
        depth: 0,
        type: 'heading',
        children: [],
        collapsed: false,
        isRoot: true,
        layout: 'radial'
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
      frontmatter,
      layout: 'radial'
    };

    let currentParentStack = [rootNode];
    let pathStack = ['root'];
    let foundFirstHeading = false;

    // Recupera cache delle posizioni manuali per questo file se presente
    const fileCache = filePath ? CUSTOM_POSITIONS_CACHE.get(filePath) || {} : {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Direttiva di layout: <!-- layout: table --> oppure <!-- mm: layout=table -->
      if (trimmed.includes('layout: table') || trimmed.includes('layout:table')) {
        const lastNode = currentParentStack[currentParentStack.length - 1];
        if (lastNode) lastNode.layout = 'table';
        continue;
      }

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
          pathStack = ['root'];
          continue;
        }
        foundFirstHeading = true;

        while (currentParentStack.length > 1 && currentParentStack[currentParentStack.length - 1].depth >= level) {
          currentParentStack.pop();
          pathStack.pop();
        }

        const parent = currentParentStack[currentParentStack.length - 1];
        const childIdx = parent.children.length;
        const parentPath = pathStack.join('_');
        const nodeId = MindmapEngine.generateDeterministicId(parentPath, childIdx, text);

        const node = {
          id: nodeId,
          text,
          depth: level,
          type: 'heading',
          children: [],
          collapsed: false,
          pdfLink,
          bodyText: '',
          layout: 'default'
        };

        // Ripristina posizione manuale se memorizzata
        if (fileCache[nodeId]) {
          node.customX = fileCache[nodeId].x;
          node.customY = fileCache[nodeId].y;
          if (fileCache[nodeId].layout) node.layout = fileCache[nodeId].layout;
        }

        parent.children.push(node);
        currentParentStack.push(node);
        pathStack.push(`h${childIdx}`);
        continue;
      }

      // Check List Item (- item, * item, + item, 1. item) -> Punti chiave
      const listMatch = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        const indent = listMatch[1].replace(/\t/g, '  ').length;
        const listLevel = (currentParentStack[currentParentStack.length - 1].depth || 1) + Math.floor(indent / 2) + 1;
        const text = listMatch[2].trim();

        while (currentParentStack.length > 1 && currentParentStack[currentParentStack.length - 1].depth >= listLevel) {
          currentParentStack.pop();
          pathStack.pop();
        }

        const parent = currentParentStack[currentParentStack.length - 1];
        const childIdx = parent.children.length;
        const parentPath = pathStack.join('_');
        const nodeId = MindmapEngine.generateDeterministicId(parentPath, childIdx, text);

        const node = {
          id: nodeId,
          text,
          depth: listLevel,
          type: 'keypoint',
          children: [],
          collapsed: false,
          pdfLink,
          bodyText: '',
          layout: 'default'
        };

        if (fileCache[nodeId]) {
          node.customX = fileCache[nodeId].x;
          node.customY = fileCache[nodeId].y;
          if (fileCache[nodeId].layout) node.layout = fileCache[nodeId].layout;
        }

        parent.children.push(node);
        currentParentStack.push(node);
        pathStack.push(`k${childIdx}`);
        continue;
      }

      // Check Tabella Markdown nativa: | Col 1 | Col 2 |
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const parent = currentParentStack[currentParentStack.length - 1];
        if (parent && !parent.isRoot) {
          parent.layout = 'table';
          if (!parent.tableData) {
            parent.tableData = { headers: [], rows: [] };
          }
          const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
          if (cells.every(c => /^[-:]+$/.test(c))) {
            // Riga di separazione, salta
          } else if (parent.tableData.headers.length === 0) {
            parent.tableData.headers = cells;
          } else {
            parent.tableData.rows.push(cells);
          }
          continue;
        }
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
        // In 'keypoints' o 'full' include anche i punti elenco
        clone.children.push(MindmapEngine.filterTreeByDetail(child, level));
      }
    }

    return clone;
  }

  /**
   * Converte l'albero in Markdown pulito preservando gerarchia, tabelle e annotazioni
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

        if (child.type === 'heading' || depth <= 2) {
          const hashes = '#'.repeat(Math.min(6, depth + 1));
          lines.push(`${hashes} ${nodeText}`);
        } else {
          const indent = '  '.repeat(Math.max(0, depth - 3));
          lines.push(`${indent}- ${nodeText}`);
        }

        // Se il nodo è configurato come tabella
        if (child.layout === 'table') {
          lines.push('<!-- layout: table -->');
          if (child.tableData && child.tableData.headers && child.tableData.headers.length) {
            lines.push(`| ${child.tableData.headers.join(' | ')} |`);
            lines.push(`| ${child.tableData.headers.map(() => '---').join(' | ')} |`);
            for (const row of child.tableData.rows || []) {
              lines.push(`| ${row.join(' | ')} |`);
            }
          }
        }

        if (child.bodyText) {
          lines.push(child.bodyText);
        }
        lines.push('');

        // Se non è tabella serializzata via righe, visita i figli
        if (child.children && child.children.length) {
          walk(child, depth + 1);
        }
      }
    };

    walk(rootNode, 1);
    return lines.join('\n');
  }

  /**
   * Calcola le dimensioni di ogni nodo in base al testo, al dettaglio e al layout
   */
  static measureNode(node, detailLevel = 'keypoints') {
    const text = node.text || '';
    const lines = text.split('\n');
    const maxLineLen = lines.reduce((max, l) => Math.max(max, l.length), 0);

    let w = Math.max(120, Math.min(320, maxLineLen * 8.8 + 36));
    let h = Math.max(42, lines.length * 20 + 18);

    if (node.layout === 'table') {
      w = Math.max(w, 360);
      const rowCount = (node.tableData && node.tableData.rows) ? node.tableData.rows.length : (node.children ? node.children.length : 1);
      h = Math.max(h, 90 + rowCount * 32);
    } else {
      if (detailLevel === 'full' && node.bodyText) {
        w = Math.max(w, 240);
        h += Math.min(120, node.bodyText.length * 0.5 + 24);
      }
      if (node.pdfLink) {
        h += 24;
        w = Math.max(w, 170);
      }
    }

    if (node.isRoot) {
      w = Math.max(160, maxLineLen * 10.5 + 50);
      h = Math.max(56, lines.length * 24 + 26);
    }

    node.width = w;
    node.height = h;

    if (node.children && node.children.length && !node.collapsed && node.layout !== 'table') {
      for (const child of node.children) {
        MindmapEngine.measureNode(child, detailLevel);
      }
    }
  }

  /**
   * Calcola l'altezza / ampiezza di un sotto-albero
   */
  static computeSubtreeHeight(node, verticalGap = 18) {
    if (!node.children || !node.children.length || node.collapsed || node.layout === 'table') {
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

  // ==========================================================================
  // LAYOUT 1: RADIALE 360° (Organica a raggiera attorno al titolo principale)
  // ==========================================================================
  static computeRadialLayout(rootNode, options = {}) {
    const detailLevel = options.detailLevel || 'keypoints';
    MindmapEngine.measureNode(rootNode, detailLevel);

    const cx = options.cx || 1400;
    const cy = options.cy || 1100;

    rootNode.x = cx - (rootNode.width / 2);
    rootNode.y = cy - (rootNode.height / 2);
    rootNode.color = '#38bdf8';
    rootNode.direction = 'center';

    const renderedNodes = [rootNode];
    const branchPaths = [];

    const chapters = rootNode.children || [];
    const N = chapters.length;
    if (N === 0) return { nodes: renderedNodes, paths: branchPaths, root: rootNode };

    // Raggi ellittici base
    const baseRx = 380;
    const baseRy = 280;

    for (let i = 0; i < N; i++) {
      const chap = chapters[i];
      const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
      chap.color = color;

      MindmapEngine.computeSubtreeHeight(chap, 20);

      // Angolo in senso orario partendo dall'alto a destra (-pi/3)
      const angle = -Math.PI / 3 + (2 * Math.PI * i / N);
      const isRight = Math.cos(angle) >= 0;
      chap.direction = isRight ? 'right' : 'left';

      // Posizione capitolo (rispetta spostamento manuale se presente)
      if (chap.customX !== undefined && chap.customY !== undefined) {
        chap.x = chap.customX;
        chap.y = chap.customY;
      } else {
        const extraR = Math.min(200, (chap.subtreeHeight || 0) * 0.2);
        const rx = baseRx + extraR;
        const ry = baseRy + extraR * 0.7;

        chap.x = cx + rx * Math.cos(angle) - (isRight ? 0 : chap.width);
        chap.y = cy + ry * Math.sin(angle) - (chap.height / 2);
      }

      renderedNodes.push(chap);

      // Curva Bezier dal centro al capitolo
      const startX = isRight ? rootNode.x + rootNode.width : rootNode.x;
      const startY = rootNode.y + (rootNode.height / 2);
      const targetX = isRight ? chap.x : chap.x + chap.width;
      const targetY = chap.y + (chap.height / 2);
      const dx = (targetX - startX) * 0.55;

      branchPaths.push({
        d: `M ${startX} ${startY} C ${startX + dx} ${startY}, ${targetX - dx} ${targetY}, ${targetX} ${targetY}`,
        color,
        fromId: rootNode.id,
        toId: chap.id
      });

      // Se il capitolo non è in modalità tabella, dirama i sotto-nodi verso l'esterno
      if (chap.layout !== 'table') {
        MindmapEngine.positionSubChildren(chap, color, chap.direction, 75, renderedNodes, branchPaths);
      }
    }

    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }

  // ==========================================================================
  // LAYOUT 2: MAPPA BILATERALE (Sinistra e Destra)
  // ==========================================================================
  static computeBilateralLayout(rootNode, options = {}) {
    const horizontalGap = options.horizontalGap || 75;
    const verticalGap = options.verticalGap || 18;
    const detailLevel = options.detailLevel || 'keypoints';

    MindmapEngine.measureNode(rootNode, detailLevel);

    const children = rootNode.children || [];
    const rightChildren = [];
    const leftChildren = [];

    // Distribuzione bilanciata destra/sinistra nel naturale ordine di lettura
    for (let i = 0; i < children.length; i++) {
      if (children[i].manualSide === 'left') {
        leftChildren.push(children[i]);
      } else if (children[i].manualSide === 'right') {
        rightChildren.push(children[i]);
      } else {
        if (i % 2 === 0) rightChildren.push(children[i]);
        else leftChildren.push(children[i]);
      }
    }

    let rightHeight = 0;
    rightChildren.forEach(c => rightHeight += MindmapEngine.computeSubtreeHeight(c, verticalGap));
    let leftHeight = 0;
    leftChildren.forEach(c => leftHeight += MindmapEngine.computeSubtreeHeight(c, verticalGap));

    const maxSideHeight = Math.max(rightHeight, leftHeight, 400);

    rootNode.x = 1000;
    rootNode.y = Math.max(280, maxSideHeight / 2);
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

      if (child.customX !== undefined && child.customY !== undefined) {
        child.x = child.customX;
        child.y = child.customY;
      } else {
        child.x = rootNode.x + rootNode.width + horizontalGap;
        child.y = curY + (child.subtreeHeight / 2) - (child.height / 2);
      }
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

      if (child.layout !== 'table') {
        MindmapEngine.positionSubChildren(child, color, 'right', horizontalGap, renderedNodes, branchPaths);
      }
    }

    // 2. Ramo Sinistro
    curY = rootNode.y + (rootNode.height / 2) - (leftHeight / 2);
    for (let i = 0; i < leftChildren.length; i++) {
      const child = leftChildren[i];
      const color = BRANCH_COLORS[(i + 4) % BRANCH_COLORS.length];
      child.color = color;
      child.direction = 'left';

      if (child.customX !== undefined && child.customY !== undefined) {
        child.x = child.customX;
        child.y = child.customY;
      } else {
        child.x = rootNode.x - child.width - horizontalGap;
        child.y = curY + (child.subtreeHeight / 2) - (child.height / 2);
      }
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

      if (child.layout !== 'table') {
        MindmapEngine.positionSubChildren(child, color, 'left', horizontalGap, renderedNodes, branchPaths);
      }
    }

    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }

  // ==========================================================================
  // LAYOUT 3: STRUTTURA AD ALBERO A DESTRA (Orizzontale compatta)
  // ==========================================================================
  static computeRightLayout(rootNode, options = {}) {
    const horizontalGap = options.horizontalGap || 75;
    const verticalGap = options.verticalGap || 18;
    const detailLevel = options.detailLevel || 'keypoints';

    MindmapEngine.measureNode(rootNode, detailLevel);
    MindmapEngine.computeSubtreeHeight(rootNode, verticalGap);

    rootNode.x = 90;
    rootNode.y = Math.max(220, (rootNode.subtreeHeight - rootNode.height) / 2);
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

        if (child.customX !== undefined && child.customY !== undefined) {
          child.x = child.customX;
          child.y = child.customY;
        } else {
          child.x = rootNode.x + rootNode.width + horizontalGap;
          child.y = curY + (child.subtreeHeight / 2) - (child.height / 2);
        }
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

        if (child.layout !== 'table') {
          MindmapEngine.positionSubChildren(child, color, 'right', horizontalGap, renderedNodes, branchPaths);
        }
      }
    }

    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }

  static positionSubChildren(parent, color, direction, horizontalGap, renderedNodes, branchPaths) {
    if (!parent.children || !parent.children.length || parent.collapsed || parent.layout === 'table') return;

    let startY = parent.y + (parent.height / 2) - (parent.subtreeHeight / 2);

    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i];
      child.color = color;
      child.direction = direction;

      if (child.customX !== undefined && child.customY !== undefined) {
        child.x = child.customX;
        child.y = child.customY;
      } else {
        if (direction === 'right') {
          child.x = parent.x + parent.width + horizontalGap;
          child.y = startY + (child.subtreeHeight / 2) - (child.height / 2);
        } else {
          child.x = parent.x - child.width - horizontalGap;
          child.y = startY + (child.subtreeHeight / 2) - (child.height / 2);
        }
      }
      startY += child.subtreeHeight;

      renderedNodes.push(child);

      if (direction === 'right') {
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

      if (child.layout !== 'table') {
        MindmapEngine.positionSubChildren(child, color, direction, horizontalGap, renderedNodes, branchPaths);
      }
    }
  }
}

// ==========================================================================
// 2. MindmapCanvas: Controller con Spostamento Libero e Floating Bar
// ==========================================================================

class MindmapCanvas {
  constructor(containerEl, options = {}) {
    this.container = containerEl;
    this.options = options;
    this.filePath = options.filePath || '';
    this.rawRootNode = options.rootNode || { id: 'root', text: 'Mappa Concettuale', children: [], isRoot: true };
    this.selectedNodeId = 'root';
    this.viewMode = options.viewMode || 'radial'; // 'radial' | 'bilateral' | 'right' | 'table' | 'outline'
    this.detailLevel = options.detailLevel || 'keypoints'; // 'titles' | 'keypoints' | 'full'

    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.isDraggingCanvas = false;
    this.dragStart = { x: 0, y: 0 };
    this.expandedNodes = new Set();

    // Stato Drag & Drop Nodi Libero
    this.draggedNodeState = null;

    this.initDOM();
    this.render();
  }

  initDOM() {
    this.container.empty();
    this.container.addClass('cds-mm-container');

    // 1. DOCK SUPERIORE UNIFICATO
    this.topDock = this.container.createDiv({ cls: 'cds-mm-top-dock' });
    this.renderTopDock();

    // 2. VIEWPORT PER IL CANVAS
    this.viewport = this.container.createDiv({ cls: 'cds-mm-viewport' });
    this.stage = this.viewport.createDiv({ cls: 'cds-mm-stage' });

    this.svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svgLayer.setAttribute('class', 'cds-mm-svg');
    this.stage.appendChild(this.svgLayer);

    this.nodesLayer = this.stage.createDiv({ cls: 'cds-mm-nodes-layer' });

    // Floating Bar contestuale sul nodo selezionato
    this.floatingBar = this.stage.createDiv({ cls: 'cds-mm-floating-bar' });
    this.floatingBar.style.display = 'none';

    // 3. CONTENITORI PER VISTE TABELLA E OUTLINE GLOBALI
    this.tableContainer = this.container.createDiv({ cls: 'cds-mm-table-container' });
    this.tableContainer.style.display = 'none';

    this.outlineContainer = this.container.createDiv({ cls: 'cds-mm-outline-container' });
    this.outlineContainer.style.display = 'none';

    // Eventi Canvas
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
      b.onmousedown = (e) => { e.stopPropagation(); };
      b.onclick = (e) => {
        e.stopPropagation();
        this.viewMode = id;
        this.renderTopDock();
        this.render();
      };
      return b;
    };

    mkViewBtn('radial', 'Radiale 360°', '🌟');
    mkViewBtn('bilateral', 'Bilaterale', '🧠');
    mkViewBtn('right', 'A Destra', '🌿');
    mkViewBtn('table', 'Tabella Globale', '📊');
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
      b.onmousedown = (e) => { e.stopPropagation(); };
      b.onclick = (e) => {
        e.stopPropagation();
        this.detailLevel = lvl;
        this.renderTopDock();
        this.render();
      };
      return b;
    };

    mkDetailBtn('titles', 'Solo Titoli', '🏷️', 'Mostra solo la gerarchia H1/H2/H3');
    mkDetailBtn('keypoints', 'Punti Chiave', '🎯', 'Mostra titoli e concetti principali evidenziati');
    mkDetailBtn('full', 'Tutto', '📖', 'Mostra anche il testo completo dei paragrafi');

    // GRUPPO 3: STRUMENTI OPERATIVI
    const groupTools = this.topDock.createDiv({ cls: 'cds-mm-dock-group' });

    const mkToolBtn = (icon, tip, onClick) => {
      const b = groupTools.createEl('button', { cls: 'cds-mm-dock-btn', attr: { title: tip } });
      b.innerHTML = icon;
      b.onmousedown = (e) => { e.stopPropagation(); };
      b.onclick = (e) => {
        e.stopPropagation();
        onClick();
      };
      return b;
    };

    mkToolBtn('➕ Figlio', 'Aggiungi Nodo Figlio (Tab)', () => this.addChildToSelected());
    mkToolBtn('⏬ Fratello', 'Aggiungi Nodo Fratello (Enter)', () => this.addSiblingToSelected());
    mkToolBtn('📊 Tabella Nodo', 'Commuta layout del nodo selezionato in Tabella', () => this.toggleTableLayoutSelected());
    mkToolBtn('🗑️', 'Elimina Nodo (Canc)', () => this.deleteSelected());

    groupTools.createDiv({ cls: 'cds-mm-divider' });

    mkToolBtn('🧭 Centra', 'Centra Mappa (Ctrl+E)', () => this.centerRoot());
    mkToolBtn('🔄 Reset Layout', 'Ripristina posizioni automatiche', () => this.resetCustomPositions());
    mkToolBtn('🔍+', 'Zoom In', () => this.setZoom(this.zoom * 1.15));
    mkToolBtn('🔍−', 'Zoom Out', () => this.setZoom(this.zoom / 1.15));
    mkToolBtn('100%', 'Reset Zoom', () => { this.zoom = 1; this.updateTransform(); });

    groupTools.createDiv({ cls: 'cds-mm-divider' });

    mkToolBtn('🖼️ SVG', 'Esporta Immagine SVG', () => this.exportSVG());
    mkToolBtn('📷 PNG', 'Esporta Immagine PNG', () => this.exportPNG());
  }

  render() {
    // 1. Modalità Tabella Globale
    if (this.viewMode === 'table') {
      this.viewport.style.display = 'none';
      this.outlineContainer.style.display = 'none';
      this.tableContainer.style.display = 'block';
      this.renderTableView();
      return;
    }

    // 2. Modalità Outline Globale
    if (this.viewMode === 'outline') {
      this.viewport.style.display = 'none';
      this.tableContainer.style.display = 'none';
      this.outlineContainer.style.display = 'block';
      this.renderOutlineView();
      return;
    }

    // 3. Modalità Canvas (Radiale, Bilaterale o A Destra)
    this.tableContainer.style.display = 'none';
    this.outlineContainer.style.display = 'none';
    this.viewport.style.display = 'block';

    const activeTree = MindmapEngine.filterTreeByDetail(this.rawRootNode, this.detailLevel);

    let layout;
    if (this.viewMode === 'radial') {
      layout = MindmapEngine.computeRadialLayout(activeTree, { detailLevel: this.detailLevel });
    } else if (this.viewMode === 'bilateral') {
      layout = MindmapEngine.computeBilateralLayout(activeTree, { detailLevel: this.detailLevel });
    } else {
      layout = MindmapEngine.computeRightLayout(activeTree, { detailLevel: this.detailLevel });
    }

    this.renderedNodes = layout.nodes;
    this.renderedPaths = layout.paths;

    // Disegna percorsi SVG
    while (this.svgLayer.firstChild) {
      this.svgLayer.removeChild(this.svgLayer.firstChild);
    }

    let minX = 0, minY = 0, maxX = 2600, maxY = 2200;

    for (const p of this.renderedPaths) {
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', p.d);
      pathEl.setAttribute('stroke', p.color);
      pathEl.setAttribute('class', 'cds-mm-branch-path' + (p.toId === this.selectedNodeId ? ' is-selected' : ''));
      pathEl.setAttribute('data-from', p.fromId);
      pathEl.setAttribute('data-to', p.toId);
      this.svgLayer.appendChild(pathEl);
    }

    // Disegna Nodi HTML
    this.nodesLayer.empty();
    let selectedNodeEl = null;

    for (const node of this.renderedNodes) {
      if (node.x + node.width > maxX) maxX = node.x + node.width + 200;
      if (node.y + node.height > maxY) maxY = node.y + node.height + 200;

      const isSelected = node.id === this.selectedNodeId;

      const nodeEl = this.nodesLayer.createDiv({
        cls: 'cds-mm-node' +
          (node.isRoot ? ' is-root' : ` level-${node.depth}`) +
          (node.type === 'keypoint' ? ' is-keypoint' : '') +
          (node.layout === 'table' ? ' is-table-node' : '') +
          (isSelected ? ' is-selected' : '') +
          (node.direction === 'left' ? ' is-left' : ' is-right')
      });

      nodeEl.setAttribute('data-node-id', node.id);
      nodeEl.style.left = `${node.x}px`;
      nodeEl.style.top = `${node.y}px`;
      nodeEl.style.width = `${node.width}px`;
      nodeEl.style.borderColor = node.isRoot ? 'rgba(255,255,255,0.45)' : node.color || '#38bdf8';

      if (isSelected) selectedNodeEl = nodeEl;

      // 1. SE IL NODO È IN MODALITÀ TABELLA INCORPORATA
      if (node.layout === 'table') {
        this.renderEmbeddedTableNode(node, nodeEl);
      } else {
        // NODO STANDARD
        const headerRow = nodeEl.createDiv({ cls: 'cds-mm-node-header' });

        if (node.type === 'keypoint') {
          headerRow.createSpan({ text: '🎯', cls: 'cds-mm-kp-badge' });
        } else if (!node.isRoot && node.depth === 1) {
          headerRow.createSpan({ text: '🏷️ Cap.', cls: 'cds-mm-chap-badge' });
        }

        const titleEl = headerRow.createDiv({ cls: 'cds-mm-node-title', text: node.text });

        // Testo di paragrafo approfondito
        if (node.bodyText) {
          if (this.detailLevel === 'full' || this.expandedNodes.has(node.id)) {
            const bodyEl = nodeEl.createDiv({ cls: 'cds-mm-node-body' });
            bodyEl.textContent = node.bodyText;
          } else if (this.detailLevel === 'keypoints') {
            const toggle = nodeEl.createDiv({ cls: 'cds-mm-expand-toggle' });
            toggle.textContent = '… Dettagli testo';
            toggle.onmousedown = (ev) => ev.stopPropagation();
            toggle.onclick = (ev) => {
              ev.stopPropagation();
              this.expandedNodes.add(node.id);
              this.render();
            };
          }
        }

        // Badge Citazione PDF
        if (node.pdfLink) {
          const badge = nodeEl.createDiv({ cls: 'cds-mm-pdf-badge' });
          badge.innerHTML = `📄 <b>${node.pdfLink.file}</b> · Pag. ${node.pdfLink.page}`;
          badge.onmousedown = (ev) => ev.stopPropagation();
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
          foldBtn.onmousedown = (ev) => ev.stopPropagation();
          foldBtn.onclick = (ev) => {
            ev.stopPropagation();
            const raw = this.findRawNode(node.id);
            if (raw) raw.collapsed = !raw.collapsed;
            node.collapsed = !node.collapsed;
            this.render();
            this.triggerSave();
          };
        }
      }

      // Eventi di selezione e inizio Drag Libero sul Nodo
      nodeEl.onmousedown = (ev) => {
        ev.stopPropagation();
        this.selectNode(node.id);
        if (ev.button === 0 && !node.isRoot) {
          this.initNodeDrag(node, nodeEl, ev);
        }
      };

      nodeEl.ondblclick = (ev) => {
        ev.stopPropagation();
        if (node.layout !== 'table') {
          this.startEditing(node, nodeEl);
        }
      };
    }

    this.svgLayer.setAttribute('width', `${maxX + 400}`);
    this.svgLayer.setAttribute('height', `${maxY + 400}`);
    this.stage.style.width = `${maxX + 400}px`;
    this.stage.style.height = `${maxY + 400}px`;

    // Aggiorna posizione Floating Bar contestuale
    this.updateFloatingBar(selectedNodeEl);
    this.updateTransform();
  }

  /**
   * Rendering della modalità Tabella Incorporata per singolo nodo (Stile MarkMind)
   */
  renderEmbeddedTableNode(node, nodeEl) {
    const topBar = nodeEl.createDiv({ cls: 'cds-mm-table-node-top' });
    const titleSpan = topBar.createSpan({ cls: 'cds-mm-table-node-title', text: node.text });

    const tools = topBar.createDiv({ cls: 'cds-mm-table-node-tools' });

    const bBranch = tools.createEl('button', { cls: 'cds-mm-mini-btn', text: '🧠 Ramo', attr: { title: 'Ritorna a vista ramificata' } });
    bBranch.onmousedown = (e) => e.stopPropagation();
    bBranch.onclick = (e) => {
      e.stopPropagation();
      node.layout = 'default';
      const raw = this.findRawNode(node.id);
      if (raw) raw.layout = 'default';
      this.render();
      this.triggerSave();
    };

    const bAddRow = tools.createEl('button', { cls: 'cds-mm-mini-btn', text: '+ Riga', attr: { title: 'Aggiungi nuova riga alla tabella' } });
    bAddRow.onmousedown = (e) => e.stopPropagation();
    bAddRow.onclick = (e) => {
      e.stopPropagation();
      if (!node.tableData) node.tableData = { headers: ['Elemento', 'Valore / Note'], rows: [] };
      node.tableData.rows.push(['Nuovo Dato', '—']);
      const raw = this.findRawNode(node.id);
      if (raw) raw.tableData = node.tableData;
      this.render();
      this.triggerSave();
    };

    // Tabella
    const tableWrap = nodeEl.createDiv({ cls: 'cds-mm-node-table-embed' });
    const table = tableWrap.createEl('table');
    const thead = table.createEl('thead');
    const trH = thead.createEl('tr');

    const headers = (node.tableData && node.tableData.headers && node.tableData.headers.length)
      ? node.tableData.headers
      : ['Punto Chiave / Parametro', 'Valore / Dettaglio'];

    headers.forEach((h, hIdx) => {
      const th = trH.createEl('th');
      const thCell = th.createDiv({ cls: 'cds-mm-th-cell', text: h });
      thCell.contentEditable = 'true';
      thCell.onmousedown = (e) => e.stopPropagation();
      thCell.onblur = () => {
        headers[hIdx] = thCell.textContent.trim();
        if (!node.tableData) node.tableData = { headers, rows: [] };
        node.tableData.headers = headers;
        const raw = this.findRawNode(node.id);
        if (raw) raw.tableData = node.tableData;
        this.triggerSave();
      };
    });

    const tbody = table.createEl('tbody');
    const rows = (node.tableData && node.tableData.rows) ? node.tableData.rows : [];

    if (!rows.length && node.children && node.children.length) {
      // Inizializza da figli se disponibili
      for (const ch of node.children) {
        rows.push([ch.text, ch.bodyText || '—']);
      }
      if (!node.tableData) node.tableData = { headers, rows };
    }

    rows.forEach((row, rIdx) => {
      const tr = tbody.createEl('tr');
      row.forEach((cellVal, cIdx) => {
        const td = tr.createEl('td');
        const tdCell = td.createDiv({ cls: 'cds-mm-td-cell', text: cellVal });
        tdCell.contentEditable = 'true';
        tdCell.onmousedown = (e) => e.stopPropagation();
        tdCell.onblur = () => {
          row[cIdx] = tdCell.textContent.trim();
          const raw = this.findRawNode(node.id);
          if (raw && raw.tableData) raw.tableData.rows[rIdx] = row;
          this.triggerSave();
        };
      });
    });
  }

  /**
   * Aggiorna la barra flottante contestuale sopra il nodo selezionato
   */
  updateFloatingBar(selectedEl) {
    if (!selectedEl || this.selectedNodeId === 'root') {
      this.floatingBar.style.display = 'none';
      return;
    }

    const rawNode = this.findRawNode(this.selectedNodeId);
    if (!rawNode) {
      this.floatingBar.style.display = 'none';
      return;
    }

    this.floatingBar.empty();
    this.floatingBar.style.display = 'flex';

    const mkFloatBtn = (iconText, title, onClick) => {
      const b = this.floatingBar.createEl('button', { cls: 'cds-mm-float-btn', attr: { title } });
      b.innerHTML = iconText;
      b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
      return b;
    };

    mkFloatBtn('➕ Figlio', 'Aggiungi nodo figlio (Tab)', () => this.addChildToSelected());
    mkFloatBtn('⏬ Fratello', 'Aggiungi nodo fratello (Enter)', () => this.addSiblingToSelected());

    const isTable = rawNode.layout === 'table';
    mkFloatBtn(isTable ? '🧠 Mappa' : '📊 Tabella', isTable ? 'Converti in Ramo Mappa' : 'Converti in Tabella Incorporata', () => this.toggleTableLayoutSelected());

    mkFloatBtn('✏️', 'Modifica Testo (F2)', () => this.startEditing(rawNode, selectedEl));
    mkFloatBtn('🗑️', 'Elimina Nodo (Canc)', () => this.deleteSelected());

    // Posizionamento al di sopra del nodo selezionato
    const nodeX = parseFloat(selectedEl.style.left) || 0;
    const nodeY = parseFloat(selectedEl.style.top) || 0;
    const nodeW = parseFloat(selectedEl.style.width) || 160;

    this.floatingBar.style.left = `${nodeX + (nodeW / 2)}px`;
    this.floatingBar.style.top = `${nodeY - 12}px`;
  }

  /**
   * SPOSTAMENTO LIBERO DEI NODI (Free Drag & Drop)
   */
  initNodeDrag(node, nodeEl, ev) {
    const rawNode = this.findRawNode(node.id);
    if (!rawNode) return;

    this.draggedNodeState = {
      node,
      rawNode,
      nodeEl,
      startX: ev.clientX,
      startY: ev.clientY,
      nodeOrigX: node.x,
      nodeOrigY: node.y,
      hasMoved: false,
      descendants: this.collectDescendants(node)
    };
  }

  collectDescendants(node) {
    const list = [];
    const walk = (n) => {
      if (!n.children) return;
      for (const ch of n.children) {
        list.push({ node: ch, origX: ch.x, origY: ch.y, rawNode: this.findRawNode(ch.id) });
        walk(ch);
      }
    };
    walk(node);
    return list;
  }

  onMouseMove(ev) {
    // 1. Spostamento Canvas (Pan)
    if (this.isDraggingCanvas) {
      this.panX = ev.clientX - this.dragStart.x;
      this.panY = ev.clientY - this.dragStart.y;
      this.updateTransform();
      return;
    }

    // 2. Spostamento Libero del Nodo
    if (this.draggedNodeState) {
      const s = this.draggedNodeState;
      const dx = (ev.clientX - s.startX) / this.zoom;
      const dy = (ev.clientY - s.startY) / this.zoom;

      if (!s.hasMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        s.hasMoved = true;
        s.nodeEl.classList.add('is-ghost');
      }

      if (s.hasMoved) {
        const newX = s.nodeOrigX + dx;
        const newY = s.nodeOrigY + dy;
        s.node.x = newX;
        s.node.y = newY;
        s.nodeEl.style.left = `${newX}px`;
        s.nodeEl.style.top = `${newY}px`;

        // Sposta tutti i discendenti insieme
        for (const desc of s.descendants) {
          desc.node.x = desc.origX + dx;
          desc.node.y = desc.origY + dy;
          const el = this.nodesLayer.querySelector(`[data-node-id="${desc.node.id}"]`);
          if (el) {
            el.style.left = `${desc.node.x}px`;
            el.style.top = `${desc.node.y}px`;
          }
        }

        // Ridisegna al volo le linee SVG collegate
        this.updateBranchPathsRealtime();

        // Evidenzia eventuale target di adozione (reparenting)
        const els = document.elementsFromPoint(ev.clientX, ev.clientY);
        const targetEl = els.find(el => el.classList && el.classList.contains('cds-mm-node') && el !== s.nodeEl);
        document.querySelectorAll('.cds-mm-node.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
        if (targetEl) {
          targetEl.classList.add('is-drop-target');
          s.hoverTargetId = targetEl.getAttribute('data-node-id');
        } else {
          s.hoverTargetId = null;
        }
      }
    }
  }

  onMouseUp(ev) {
    if (this.isDraggingCanvas) {
      this.isDraggingCanvas = false;
      this.viewport.removeClass('is-dragging');
    }

    if (this.draggedNodeState) {
      const s = this.draggedNodeState;
      this.draggedNodeState = null;
      s.nodeEl.classList.remove('is-ghost');
      document.querySelectorAll('.cds-mm-node.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));

      if (s.hasMoved) {
        // A. RILASCIO SOPRA UN ALTRO NODO -> REPARENTING (Adozione gerarchica)
        if (s.hoverTargetId && s.hoverTargetId !== s.node.id) {
          const isDescendant = s.descendants.some(d => d.node.id === s.hoverTargetId);
          if (!isDescendant) {
            const oldParent = this.findParent(s.node.id);
            const newParent = this.findRawNode(s.hoverTargetId);
            if (oldParent && newParent && oldParent.id !== newParent.id) {
              oldParent.children = oldParent.children.filter(c => c.id !== s.node.id);
              s.rawNode.depth = newParent.depth + 1;
              newParent.children.push(s.rawNode);
              newParent.collapsed = false;

              // Rimuovi coordinate custom per far riorganizzare la gerarchia
              delete s.rawNode.customX;
              delete s.rawNode.customY;

              new Notice(`Spostato "${s.rawNode.text.slice(0, 20)}" sotto "${newParent.text.slice(0, 20)}"`);
              this.render();
              this.triggerSave();
              return;
            }
          }
        }

        // B. RILASCIO NELLO SPAZIO VUOTO -> SALVATAGGIO COORDINATE LIBERE
        s.rawNode.customX = s.node.x;
        s.rawNode.customY = s.node.y;

        // Salva anche coordinate per discendenti
        for (const desc of s.descendants) {
          if (desc.rawNode) {
            desc.rawNode.customX = desc.node.x;
            desc.rawNode.customY = desc.node.y;
          }
        }

        // Aggiorna cache sessione
        if (this.filePath) {
          const fc = CUSTOM_POSITIONS_CACHE.get(this.filePath) || {};
          fc[s.rawNode.id] = { x: s.rawNode.customX, y: s.rawNode.customY, layout: s.rawNode.layout };
          CUSTOM_POSITIONS_CACHE.set(this.filePath, fc);
        }

        this.render();
        this.triggerSave();
      }
    }
  }

  updateBranchPathsRealtime() {
    for (const p of this.renderedPaths) {
      const fromNode = this.renderedNodes.find(n => n.id === p.fromId);
      const toNode = this.renderedNodes.find(n => n.id === p.toId);
      if (fromNode && toNode) {
        const isRight = toNode.x >= fromNode.x;
        const x1 = isRight ? fromNode.x + fromNode.width : fromNode.x;
        const y1 = fromNode.y + (fromNode.height / 2);
        const x2 = isRight ? toNode.x : toNode.x + toNode.width;
        const y2 = toNode.y + (toNode.height / 2);
        const dx = (x2 - x1) * 0.55;
        p.d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

        const pathEl = this.svgLayer.querySelector(`[data-to="${p.toId}"]`);
        if (pathEl) {
          pathEl.setAttribute('d', p.d);
        }
      }
    }
  }

  resetCustomPositions() {
    const clearWalk = (n) => {
      delete n.customX;
      delete n.customY;
      if (n.children) n.children.forEach(clearWalk);
    };
    clearWalk(this.rawRootNode);

    if (this.filePath) {
      CUSTOM_POSITIONS_CACHE.delete(this.filePath);
    }

    new Notice('✅ Coordinate ripristinate alla geometria automatica');
    this.render();
    this.centerRoot();
  }

  toggleTableLayoutSelected() {
    const raw = this.findRawNode(this.selectedNodeId);
    if (!raw || raw.isRoot) {
      new Notice('Seleziona un capitolo o sezione da convertire in tabella.');
      return;
    }

    raw.layout = (raw.layout === 'table') ? 'default' : 'table';
    new Notice(raw.layout === 'table' ? '📊 Impostata vista Tabella per il nodo' : '🧠 Ripristinata vista Mappa');
    this.render();
    this.triggerSave();
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

    const childIdx = parent.children.length;
    const parentPath = parent.id;
    const newId = MindmapEngine.generateDeterministicId(parentPath, childIdx, defaultText);

    const newNode = {
      id: newId,
      text: defaultText,
      depth: (parent.depth || 0) + 1,
      type: parent.depth === 0 ? 'heading' : 'keypoint',
      children: [],
      collapsed: false,
      pdfLink,
      bodyText: '',
      layout: 'default'
    };

    parent.children.push(newNode);
    this.selectedNodeId = newNode.id;
    this.render();
    this.triggerSave();

    setTimeout(() => {
      const nodeEl = this.nodesLayer.querySelector(`[data-node-id="${newNode.id}"]`);
      if (nodeEl) this.startEditing(newNode, nodeEl);
    }, 60);
  }

  addSiblingToSelected(defaultText = 'Nuovo Ramo') {
    if (this.selectedNodeId === 'root') {
      this.addChildToSelected(defaultText);
      return;
    }
    const parent = this.findParent(this.selectedNodeId);
    if (!parent) return;

    const idx = parent.children.findIndex(c => c.id === this.selectedNodeId);
    const childIdx = parent.children.length;
    const parentPath = parent.id;
    const newId = MindmapEngine.generateDeterministicId(parentPath, childIdx, defaultText);

    const newNode = {
      id: newId,
      text: defaultText,
      depth: parent.depth + 1,
      type: parent.depth === 0 ? 'heading' : 'keypoint',
      children: [],
      collapsed: false,
      bodyText: '',
      layout: 'default'
    };

    parent.children.splice(idx + 1, 0, newNode);
    this.selectedNodeId = newNode.id;
    this.render();
    this.triggerSave();

    setTimeout(() => {
      const nodeEl = this.nodesLayer.querySelector(`[data-node-id="${newNode.id}"]`);
      if (nodeEl) this.startEditing(newNode, nodeEl);
    }, 60);
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

    const titleEl = nodeEl.querySelector('.cds-mm-node-title') || nodeEl;
    titleEl.style.visibility = 'hidden';

    const input = document.createElement('textarea');
    input.className = 'cds-mm-editor-input';
    input.value = node.text;

    const rect = nodeEl.getBoundingClientRect();
    const stageRect = this.stage.getBoundingClientRect();

    input.style.left = `${node.x}px`;
    input.style.top = `${node.y}px`;
    input.style.width = `${Math.max(node.width, 200)}px`;
    input.style.height = `${Math.max(node.height, 56)}px`;

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
      titleEl.style.visibility = 'visible';
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
        titleEl.style.visibility = 'visible';
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
      const nodeEl = this.nodesLayer.querySelector(`[data-node-id="${this.selectedNodeId}"]`);
      if (node && nodeEl) this.startEditing(node, nodeEl);
    } else if (e.key === 'e' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.centerRoot();
    }
  }

  onMouseDown(e) {
    if (e.target.closest('.cds-mm-node') || e.target.closest('.cds-mm-top-dock') || e.target.closest('.cds-mm-floating-bar')) return;
    this.isDraggingCanvas = true;
    this.viewport.addClass('is-dragging');
    this.dragStart = { x: e.clientX - this.panX, y: e.clientY - this.panY };
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

    if (this.viewMode === 'radial') {
      this.panX = (vW / 2) - 1400;
      this.panY = (vH / 2) - 1100;
    } else if (this.viewMode === 'bilateral') {
      this.panX = (vW / 2) - 1000 - (this.rawRootNode.width / 2);
      this.panY = (vH / 2) - 280 - (this.rawRootNode.height / 2);
    } else {
      this.panX = Math.max(60, vW * 0.1);
      this.panY = Math.max(60, (vH / 2) - 150);
    }
    this.zoom = 1;
    this.updateTransform();
  }

  /**
   * VISTA TABELLA GLOBALE
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
   * VISTA OUTLINE GLOBALE
   */
  renderOutlineView() {
    this.outlineContainer.empty();
    this.outlineContainer.createEl('h2', { text: this.rawRootNode.text || 'Outline', attr: { style: 'color:#38bdf8;margin-bottom:18px;' } });

    const walk = (node, container, level) => {
      if (!node.children || !node.children.length) return;

      for (const child of node.children) {
        const item = container.createDiv({ cls: 'cds-mm-outline-item' });
        item.style.paddingLeft = `${level * 24}px`;

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
      canvas.width = parseInt(this.svgLayer.getAttribute('width') || '2000', 10);
      canvas.height = parseInt(this.svgLayer.getAttribute('height') || '1500', 10);
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

    const rootNode = MindmapEngine.parseMarkdown(content, this.file.basename, this.file.path);

    this.canvas = new MindmapCanvas(this.contentEl, {
      rootNode,
      frontmatter,
      filePath: this.file.path,
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
    const newRoot = MindmapEngine.parseMarkdown(content, this.file.basename, this.file.path);

    // Preserva selezione
    const prevSelectedId = this.canvas.selectedNodeId;
    this.canvas.rawRootNode = newRoot;
    if (this.canvas.findRawNode(prevSelectedId)) {
      this.canvas.selectedNodeId = prevSelectedId;
    }
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
// 4. CdsMindmapPlugin: Lifecycle & Registrazione Comandi
// ==========================================================================

module.exports = class CdsMindmapPlugin extends Plugin {
  async onload() {
    console.log('Loading CDS Mindmap Suite v2.2 (Radial 360 & Free Nodes)');

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
      name: 'Crea nuova Mappa Concettuale Radiale',
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
    console.log('Unloading CDS Mindmap Suite');
  }
};
