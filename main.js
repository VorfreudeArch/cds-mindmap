const { Plugin, ItemView, WorkspaceLeaf, Notice, TFile, MarkdownRenderer, Modal } = require('obsidian');

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

const PAPER_SIZES = {
  Auto: { label: 'Adattivo (Mappa)', w: 0, h: 0, ratio: 0 },
  A0: { label: 'A0 (841 × 1189 mm)', w: 841, h: 1189, ratio: 1189 / 841 },
  A1: { label: 'A1 (594 × 841 mm)', w: 594, h: 841, ratio: 841 / 594 },
  A2: { label: 'A2 (420 × 594 mm)', w: 420, h: 594, ratio: 594 / 420 },
  A3: { label: 'A3 (297 × 420 mm)', w: 297, h: 420, ratio: 420 / 297 },
  A4: { label: 'A4 (210 × 297 mm)', w: 210, h: 297, ratio: 297 / 210 },
  A5: { label: 'A5 (148 × 210 mm)', w: 148, h: 210, ratio: 210 / 148 },
  A6: { label: 'A6 (105 × 148 mm)', w: 105, h: 148, ratio: 148 / 105 }
};

// Session cache per le posizioni e layout personalizzati dei nodi per file
const CUSTOM_POSITIONS_CACHE = new Map();

// ==========================================================================
// 1. MindmapEngine: Parser, Serializer, Filtro Dettaglio, Rich MD & Multi-Layout
// ==========================================================================

class MindmapEngine {
  static generateDeterministicId(parentPath, index, text) {
    const clean = (text || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
    return parentPath ? `${parentPath}_${index}_${clean}` : 'root';
  }

  /**
   * Renderizzatore veloce e leggero di Markdown all'interno dei nodi
   */
  static renderMiniMarkdown(text) {
    if (!text) return '';
    let res = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.*?)\*/g, '<i>$1</i>')
      .replace(/==(.*?)==/g, '<mark class="cds-mm-mark">$1</mark>')
      .replace(/`([^`]+)`/g, '<code class="cds-mm-code">$1</code>')
      .replace(/\[\[(.*?)\|(.*?)\]\]/g, '<span class="cds-mm-wikilink" data-target="$1">🔗 $2</span>')
      .replace(/\[\[(.*?)\]\]/g, '<span class="cds-mm-wikilink" data-target="$1">🔗 $1</span>')
      .replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="cds-mm-ext-link">$1 ↗</a>');
    return res;
  }

  /**
   * Estrae immagini incorporate dal testo: ![[immagine.png]] o ![alt](url)
   */
  static extractImages(text) {
    const images = [];
    if (!text) return images;

    const wikiImgRegex = /!\[\[([^\]]+\.(?:png|jpg|jpeg|gif|webp|svg))\]\]/gi;
    let m;
    while ((m = wikiImgRegex.exec(text)) !== null) {
      images.push({ type: 'vault', path: m[1].trim() });
    }

    const mdImgRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi;
    while ((m = mdImgRegex.exec(text)) !== null) {
      images.push({ type: 'web', path: m[2].trim(), alt: m[1] });
    }

    return images;
  }

  /**
   * Analizza Markdown e costruisce l'albero AST con numeri di riga e supporto multimediale
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
        sourceLine: 0,
        layout: 'radial'
      };
    }

    let content = mdText;
    let frontmatter = null;
    let lineOffset = 0;

    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (fmMatch) {
      frontmatter = fmMatch[1];
      const fmLines = fmMatch[0].split(/\r?\n/).length - 1;
      lineOffset = fmLines;
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
      sourceLine: lineOffset,
      layout: 'radial'
    };

    let currentParentStack = [rootNode];
    let pathStack = ['root'];
    let foundFirstHeading = false;

    const fileCache = filePath ? CUSTOM_POSITIONS_CACHE.get(filePath) || {} : {};

    for (let i = 0; i < lines.length; i++) {
      const lineNum = lineOffset + i;
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Direttiva layout: <!-- layout: table -->
      if (trimmed.includes('layout: table') || trimmed.includes('layout:table')) {
        const lastNode = currentParentStack[currentParentStack.length - 1];
        if (lastNode) lastNode.layout = 'table';
        continue;
      }

      // Link PDF
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

      // Immagini
      const images = MindmapEngine.extractImages(trimmed);

      // Check Heading (# H1..H6)
      const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        const text = hMatch[2].trim();

        if (!foundFirstHeading && level === 1) {
          rootNode.text = text;
          rootNode.sourceLine = lineNum;
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
          images,
          bodyText: '',
          sourceLine: lineNum,
          layout: 'default'
        };

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

        let baseHeadingDepth = 1;
        for (let s = currentParentStack.length - 1; s >= 0; s--) {
          if (currentParentStack[s].type === 'heading') {
            baseHeadingDepth = currentParentStack[s].depth || 1;
            break;
          }
        }
        const listLevel = baseHeadingDepth + 1 + Math.floor(indent / 2);
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
          images,
          bodyText: '',
          sourceLine: lineNum,
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

      // Check Tabella Markdown
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const parent = currentParentStack[currentParentStack.length - 1];
        if (parent && !parent.isRoot) {
          parent.layout = 'table';
          if (!parent.tableData) {
            parent.tableData = { headers: [], rows: [] };
          }
          const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
          if (cells.every(c => /^[-:]+$/.test(c))) {
            // Sep row
          } else if (parent.tableData.headers.length === 0) {
            parent.tableData.headers = cells;
          } else {
            parent.tableData.rows.push(cells);
          }
          continue;
        }
      }

      // Testo normale di paragrafo
      if (currentParentStack.length > 1) {
        const lastNode = currentParentStack[currentParentStack.length - 1];
        if (lastNode && !lastNode.isRoot) {
          lastNode.bodyText = (lastNode.bodyText ? lastNode.bodyText + '\n' : '') + trimmed;
          if (images.length) {
            lastNode.images = (lastNode.images || []).concat(images);
          }
        }
      }
    }

    return rootNode;
  }

  static filterTreeByDetail(node, level = 'keypoints') {
    const clone = {
      ...node,
      children: []
    };

    if (node.children && node.children.length) {
      for (const child of node.children) {
        if (level === 'titles' && child.type !== 'heading') {
          continue;
        }
        clone.children.push(MindmapEngine.filterTreeByDetail(child, level));
      }
    }

    return clone;
  }

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

        if (child.children && child.children.length) {
          walk(child, depth + 1);
        }
      }
    };

    walk(rootNode, 1);
    return lines.join('\n');
  }

  static measureNode(node, detailLevel = 'keypoints') {
    const text = node.text || '';
    const cleanText = text.replace(/\[\[.*?\]\]/g, 'Link').replace(/\*\*|==|\*|`/g, '');
    const lines = cleanText.split('\n');
    const maxLineLen = lines.reduce((max, l) => Math.max(max, l.length), 0);

    let w = Math.max(130, Math.min(340, maxLineLen * 9.0 + 40));
    let h = Math.max(46, lines.length * 22 + 20);

    if (node.images && node.images.length) {
      w = Math.max(w, 240);
      h += 110; // Spazio miniatura
    }

    if (node.layout === 'table') {
      w = Math.max(w, 380);
      const rowCount = (node.tableData && node.tableData.rows) ? node.tableData.rows.length : (node.children ? node.children.length : 1);
      h = Math.max(h, 95 + rowCount * 34);
    } else {
      if (detailLevel === 'full' && node.bodyText) {
        w = Math.max(w, 260);
        h += Math.min(130, node.bodyText.length * 0.5 + 26);
      }
      if (node.pdfLink) {
        h += 24;
        w = Math.max(w, 180);
      }
    }

    if (node.isRoot) {
      w = Math.max(220, maxLineLen * 11 + 60);
      h = Math.max(68, lines.length * 26 + 32);
    }

    node.width = w;
    node.height = h;

    if (node.children && node.children.length && !node.collapsed && node.layout !== 'table') {
      for (const child of node.children) {
        MindmapEngine.measureNode(child, detailLevel);
      }
    }
  }

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
  // LAYOUT 1: RADIALE 360°
  // ==========================================================================
  static computeRadialLayout(rootNode, options = {}) {
    const detailLevel = options.detailLevel || 'keypoints';
    MindmapEngine.measureNode(rootNode, detailLevel);

    const cx = options.cx || 1500;
    const cy = options.cy || 1200;

    rootNode.x = cx - (rootNode.width / 2);
    rootNode.y = cy - (rootNode.height / 2);
    rootNode.color = '#38bdf8';
    rootNode.direction = 'center';

    const renderedNodes = [rootNode];
    const branchPaths = [];

    const chapters = rootNode.children || [];
    const N = chapters.length;
    if (N === 0) return { nodes: renderedNodes, paths: branchPaths, root: rootNode };

    const baseRx = 400;
    const baseRy = 300;

    for (let i = 0; i < N; i++) {
      const chap = chapters[i];
      const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
      chap.color = color;

      MindmapEngine.computeSubtreeHeight(chap, 20);

      const angle = -Math.PI / 3 + (2 * Math.PI * i / N);
      const isRight = Math.cos(angle) >= 0;
      chap.direction = isRight ? 'right' : 'left';

      if (chap.customX !== undefined && chap.customY !== undefined) {
        chap.x = chap.customX;
        chap.y = chap.customY;
      } else {
        const extraR = Math.min(220, (chap.subtreeHeight || 0) * 0.22);
        const rx = baseRx + extraR;
        const ry = baseRy + extraR * 0.75;

        chap.x = cx + rx * Math.cos(angle) - (isRight ? 0 : chap.width);
        chap.y = cy + ry * Math.sin(angle) - (chap.height / 2);
      }

      renderedNodes.push(chap);

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

      if (chap.layout !== 'table') {
        MindmapEngine.positionSubChildren(chap, color, chap.direction, 80, renderedNodes, branchPaths);
      }
    }

    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }

  // ==========================================================================
  // LAYOUT 2: BILATERALE
  // ==========================================================================
  static computeBilateralLayout(rootNode, options = {}) {
    const horizontalGap = options.horizontalGap || 80;
    const verticalGap = options.verticalGap || 18;
    const detailLevel = options.detailLevel || 'keypoints';

    MindmapEngine.measureNode(rootNode, detailLevel);

    const children = rootNode.children || [];
    const rightChildren = [];
    const leftChildren = [];

    for (let i = 0; i < children.length; i++) {
      if (children[i].manualSide === 'left') leftChildren.push(children[i]);
      else if (children[i].manualSide === 'right') rightChildren.push(children[i]);
      else if (i % 2 === 0) rightChildren.push(children[i]);
      else leftChildren.push(children[i]);
    }

    let rightHeight = 0;
    rightChildren.forEach(c => rightHeight += MindmapEngine.computeSubtreeHeight(c, verticalGap));
    let leftHeight = 0;
    leftChildren.forEach(c => leftHeight += MindmapEngine.computeSubtreeHeight(c, verticalGap));

    const maxSideHeight = Math.max(rightHeight, leftHeight, 400);

    rootNode.x = 1100;
    rootNode.y = Math.max(300, maxSideHeight / 2);
    rootNode.color = '#38bdf8';
    rootNode.direction = 'center';

    const renderedNodes = [rootNode];
    const branchPaths = [];

    // Ramo Destro
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

    // Ramo Sinistro
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
  // LAYOUT 3: AD ALBERO A DESTRA
  // ==========================================================================
  static computeRightLayout(rootNode, options = {}) {
    const horizontalGap = options.horizontalGap || 80;
    const verticalGap = options.verticalGap || 18;
    const detailLevel = options.detailLevel || 'keypoints';

    MindmapEngine.measureNode(rootNode, detailLevel);
    MindmapEngine.computeSubtreeHeight(rootNode, verticalGap);

    rootNode.x = 90;
    rootNode.y = Math.max(240, (rootNode.subtreeHeight - rootNode.height) / 2);
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
// 2. MindmapExportModal: Anteprima Live ed Esportazione A0 - A6
// ==========================================================================

class MindmapExportModal extends Modal {
  constructor(app, canvas) {
    super(app);
    this.canvas = canvas;
    this.format = 'png'; // 'png' | 'jpg' | 'pdf' | 'svg'
    this.paperSize = 'Auto'; // 'Auto', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'
    this.orientation = 'landscape'; // 'landscape' | 'portrait'
    this.bgStyle = 'dark'; // 'dark' | 'light' | 'transparent'
    this.qualityDpi = 2; // 1x, 2x, 4x
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('cds-mm-export-modal');

    contentEl.createEl('h2', { text: '🎨 Esportazione Mappa Concettuale (Anteprima HD)', cls: 'cds-mm-export-title' });

    const layoutWrap = contentEl.createDiv({ cls: 'cds-mm-export-layout' });

    // Colonna sinistra: Opzioni
    const sidebar = layoutWrap.createDiv({ cls: 'cds-mm-export-sidebar' });

    // 1. Formato File
    sidebar.createEl('label', { text: 'Formato File:', cls: 'cds-mm-export-label' });
    const fmtSelect = sidebar.createEl('select', { cls: 'cds-mm-export-select' });
    ['png', 'jpg', 'pdf', 'svg'].forEach(f => {
      const opt = fmtSelect.createEl('option', { value: f, text: f.toUpperCase() });
      if (f === this.format) opt.selected = true;
    });
    fmtSelect.onchange = () => {
      this.format = fmtSelect.value;
      this.updatePreview();
    };

    // 2. Formato Carta (da A0 ad A6)
    sidebar.createEl('label', { text: 'Formato Carta (ISO 216):', cls: 'cds-mm-export-label' });
    const paperSelect = sidebar.createEl('select', { cls: 'cds-mm-export-select' });
    Object.keys(PAPER_SIZES).forEach(k => {
      const opt = paperSelect.createEl('option', { value: k, text: PAPER_SIZES[k].label });
      if (k === this.paperSize) opt.selected = true;
    });
    paperSelect.onchange = () => {
      this.paperSize = paperSelect.value;
      this.updatePreview();
    };

    // 3. Orientamento
    sidebar.createEl('label', { text: 'Orientamento Pagina:', cls: 'cds-mm-export-label' });
    const orientSelect = sidebar.createEl('select', { cls: 'cds-mm-export-select' });
    orientSelect.createEl('option', { value: 'landscape', text: 'Orizzontale (Landscape)' });
    orientSelect.createEl('option', { value: 'portrait', text: 'Verticale (Portrait)' });
    orientSelect.value = this.orientation;
    orientSelect.onchange = () => {
      this.orientation = orientSelect.value;
      this.updatePreview();
    };

    // 4. Sfondo
    sidebar.createEl('label', { text: 'Colore Sfondo:', cls: 'cds-mm-export-label' });
    const bgSelect = sidebar.createEl('select', { cls: 'cds-mm-export-select' });
    bgSelect.createEl('option', { value: 'dark', text: 'Scuro Grafite (#0d1117)' });
    bgSelect.createEl('option', { value: 'light', text: 'Chiaro Carta (#ffffff)' });
    bgSelect.createEl('option', { value: 'transparent', text: 'Trasparente (PNG/SVG)' });
    bgSelect.value = this.bgStyle;
    bgSelect.onchange = () => {
      this.bgStyle = bgSelect.value;
      this.updatePreview();
    };

    // 5. Risoluzione
    sidebar.createEl('label', { text: 'Risoluzione di Stampa:', cls: 'cds-mm-export-label' });
    const dpiSelect = sidebar.createEl('select', { cls: 'cds-mm-export-select' });
    dpiSelect.createEl('option', { value: '1', text: 'Standard Schermo (1x - 72 DPI)' });
    dpiSelect.createEl('option', { value: '2', text: 'Alta Definizione (2x - 150 DPI)' });
    dpiSelect.createEl('option', { value: '4', text: 'Stampa Tipografica (4x - 300 DPI)' });
    dpiSelect.value = String(this.qualityDpi);
    dpiSelect.onchange = () => {
      this.qualityDpi = parseInt(dpiSelect.value, 10);
      this.updatePreview();
    };

    // Pulsante Download
    const bDownload = sidebar.createEl('button', { cls: 'cds-mm-btn-primary', text: '💾 Esporta e Scarica' });
    bDownload.onclick = () => this.doExport();

    // Colonna destra: Box Anteprima
    this.previewBox = layoutWrap.createDiv({ cls: 'cds-mm-export-preview-box' });
    this.previewCanvas = this.previewBox.createEl('canvas', { cls: 'cds-mm-export-canvas-preview' });

    this.updatePreview();
  }

  updatePreview() {
    const nodes = this.canvas.renderedNodes || [];
    if (!nodes.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.width > maxX) maxX = n.x + n.width;
      if (n.y + n.height > maxY) maxY = n.y + n.height;
    }

    const padding = 60;
    const contentW = (maxX - minX) + padding * 2;
    const contentH = (maxY - minY) + padding * 2;

    let targetW = contentW;
    let targetH = contentH;

    if (this.paperSize !== 'Auto' && PAPER_SIZES[this.paperSize]) {
      const p = PAPER_SIZES[this.paperSize];
      let paperRatio = p.ratio;
      if (this.orientation === 'landscape') {
        paperRatio = 1 / paperRatio;
      }
      if (contentW / contentH > paperRatio) {
        targetW = contentW;
        targetH = contentW / paperRatio;
      } else {
        targetH = contentH;
        targetW = contentH * paperRatio;
      }
    }

    const pCanvas = this.previewCanvas;
    const maxPrevW = 480;
    const scale = maxPrevW / targetW;

    pCanvas.width = maxPrevW;
    pCanvas.height = Math.round(targetH * scale);

    const ctx = pCanvas.getContext('2d');
    ctx.clearRect(0, 0, pCanvas.width, pCanvas.height);

    // Sfondo
    if (this.bgStyle === 'light') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pCanvas.width, pCanvas.height);
    } else if (this.bgStyle === 'dark') {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, pCanvas.width, pCanvas.height);
    }

    // Disegna cornice pagina se formato A0-A6
    if (this.paperSize !== 'Auto') {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(2, 2, pCanvas.width - 4, pCanvas.height - 4);
    }

    // Offset centratura contenuto
    const offsetX = (targetW - contentW) / 2 + padding - minX;
    const offsetY = (targetH - contentH) / 2 + padding - minY;

    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(offsetX, offsetY);

    // Disegna percorsi SVG
    for (const p of this.canvas.renderedPaths || []) {
      ctx.strokeStyle = p.color || '#38bdf8';
      ctx.lineWidth = 2.5;
      const path2d = new Path2D(p.d);
      ctx.stroke(path2d);
    }

    // Disegna nodi
    for (const n of nodes) {
      ctx.fillStyle = n.isRoot ? '#2563eb' : (this.bgStyle === 'light' ? '#f1f5f9' : '#1e293b');
      ctx.strokeStyle = n.color || '#38bdf8';
      ctx.lineWidth = 1.8;

      ctx.beginPath();
      ctx.roundRect(n.x, n.y, n.width, n.height, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = (this.bgStyle === 'light' && !n.isRoot) ? '#0f172a' : '#ffffff';
      ctx.font = n.isRoot ? 'bold 16px sans-serif' : '13px sans-serif';
      ctx.fillText(n.text.slice(0, 26), n.x + 8, n.y + (n.height / 2) + 4);
    }

    ctx.restore();
  }

  doExport() {
    const title = (this.canvas.rawRootNode.text || 'mindmap').replace(/[/\\?%*:|"<>]/g, '_');
    const ext = this.format;
    const fileName = `${title}_${this.paperSize}_${this.orientation}.${ext}`;

    if (this.format === 'svg') {
      this.canvas.exportSVG();
      this.close();
      return;
    }

    // Render su canvas ad alta risoluzione
    const nodes = this.canvas.renderedNodes || [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.width > maxX) maxX = n.x + n.width;
      if (n.y + n.height > maxY) maxY = n.y + n.height;
    }

    const padding = 70;
    const contentW = (maxX - minX) + padding * 2;
    const contentH = (maxY - minY) + padding * 2;

    let targetW = contentW;
    let targetH = contentH;

    if (this.paperSize !== 'Auto' && PAPER_SIZES[this.paperSize]) {
      const p = PAPER_SIZES[this.paperSize];
      let paperRatio = p.ratio;
      if (this.orientation === 'landscape') paperRatio = 1 / paperRatio;
      if (contentW / contentH > paperRatio) {
        targetW = contentW;
        targetH = contentW / paperRatio;
      } else {
        targetH = contentH;
        targetW = contentH * paperRatio;
      }
    }

    const exportCanvas = document.createElement('canvas');
    const dpi = this.qualityDpi;
    exportCanvas.width = Math.round(targetW * dpi);
    exportCanvas.height = Math.round(targetH * dpi);

    const ctx = exportCanvas.getContext('2d');
    ctx.scale(dpi, dpi);

    if (this.bgStyle === 'light') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, targetW, targetH);
    } else if (this.bgStyle === 'dark') {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, targetW, targetH);
    }

    const offsetX = (targetW - contentW) / 2 + padding - minX;
    const offsetY = (targetH - contentH) / 2 + padding - minY;

    ctx.save();
    ctx.translate(offsetX, offsetY);

    for (const p of this.canvas.renderedPaths || []) {
      ctx.strokeStyle = p.color || '#38bdf8';
      ctx.lineWidth = 2.8;
      const path2d = new Path2D(p.d);
      ctx.stroke(path2d);
    }

    for (const n of nodes) {
      ctx.fillStyle = n.isRoot ? '#2563eb' : (this.bgStyle === 'light' ? '#f8fafc' : '#1a2238');
      ctx.strokeStyle = n.color || '#38bdf8';
      ctx.lineWidth = 2;

      ctx.beginPath();
      ctx.roundRect(n.x, n.y, n.width, n.height, 8);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = (this.bgStyle === 'light' && !n.isRoot) ? '#0f172a' : '#ffffff';
      ctx.font = n.isRoot ? 'bold 18px sans-serif' : '14px sans-serif';
      ctx.fillText(n.text, n.x + 12, n.y + (n.height / 2) + 5);
    }

    ctx.restore();

    if (this.format === 'pdf') {
      // Per PDF: apre la finestra di stampa con anteprima 1:1 o esporta come immagine formattata per stampa
      const dataUrl = exportCanvas.toDataURL('image/jpeg', 0.95);
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(`
          <html>
            <head>
              <title>${title} - Esportazione ${this.paperSize}</title>
              <style>
                @page { size: ${this.paperSize === 'Auto' ? 'auto' : this.paperSize} ${this.orientation}; margin: 0; }
                body { margin: 0; display: flex; align-items: center; justify-content: center; background: ${this.bgStyle === 'light' ? '#ffffff' : '#0d1117'}; }
                img { width: 100vw; height: 100vh; object-fit: contain; }
              </style>
            </head>
            <body>
              <img src="${dataUrl}" onload="window.print();" />
            </body>
          </html>
        `);
        printWindow.document.close();
      }
      new Notice(`📄 Finestra di stampa PDF ${this.paperSize} avviata!`);
    } else {
      const mime = this.format === 'jpg' ? 'image/jpeg' : 'image/png';
      exportCanvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        new Notice(`✅ Mappa esportata come ${fileName}!`);
      }, mime, 0.95);
    }

    this.close();
  }
}

// ==========================================================================
// 3. MindmapCanvas: Controller con Minimap, Fit-To-Screen e Rich Markdown
// ==========================================================================

class MindmapCanvas {
  constructor(containerEl, options = {}) {
    this.container = containerEl;
    this.options = options;
    this.app = options.app || null;
    this.plugin = options.plugin || null;
    this.filePath = options.filePath || '';
    this.rawRootNode = options.rootNode || { id: 'root', text: 'Mappa Concettuale', children: [], isRoot: true };
    this.selectedNodeId = 'root';
    this.viewMode = options.viewMode || 'radial';
    this.detailLevel = options.detailLevel || 'keypoints';

    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.isDraggingCanvas = false;
    this.dragStart = { x: 0, y: 0 };
    this.expandedNodes = new Set();
    this.showMinimap = true;

    this.draggedNodeState = null;

    this.initDOM();
    this.render();
  }

  initDOM() {
    this.container.empty();
    this.container.addClass('cds-mm-container');

    // 1. DOCK SUPERIORE RESPONSIVE
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

    // 3. MINIMAP RADAR IN BASSO A DESTRA
    this.minimapWrap = this.container.createDiv({ cls: 'cds-mm-minimap' });
    this.minimapCanvas = this.minimapWrap.createEl('canvas', { cls: 'cds-mm-minimap-canvas' });
    this.minimapCanvas.width = 170;
    this.minimapCanvas.height = 110;
    this.minimapLens = this.minimapWrap.createDiv({ cls: 'cds-mm-minimap-lens' });
    this.setupMinimapEvents();

    // 4. CONTENITORI PER TABELLA E OUTLINE GLOBALI
    this.tableContainer = this.container.createDiv({ cls: 'cds-mm-table-container' });
    this.tableContainer.style.display = 'none';

    this.outlineContainer = this.container.createDiv({ cls: 'cds-mm-outline-container' });
    this.outlineContainer.style.display = 'none';

    // Eventi Canvas
    this.viewport.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Tastiera
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
      b.innerHTML = `${icon} <span class="cds-mm-btn-text">${label}</span>`;
      b.onmousedown = (e) => e.stopPropagation();
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
    mkViewBtn('table', 'Tabella', '📊');
    mkViewBtn('outline', 'Outline', '📑');

    // GRUPPO 2: DETTAGLIO
    const groupDetail = this.topDock.createDiv({ cls: 'cds-mm-dock-group' });
    groupDetail.createSpan({ text: 'Dettaglio:', cls: 'cds-mm-dock-label' });

    const mkDetailBtn = (lvl, label, icon, tip) => {
      const b = groupDetail.createEl('button', {
        cls: 'cds-mm-dock-btn' + (this.detailLevel === lvl ? ' is-active' : ''),
        attr: { title: tip }
      });
      b.innerHTML = `${icon} <span class="cds-mm-btn-text">${label}</span>`;
      b.onmousedown = (e) => e.stopPropagation();
      b.onclick = (e) => {
        e.stopPropagation();
        this.detailLevel = lvl;
        this.renderTopDock();
        this.render();
      };
      return b;
    };

    mkDetailBtn('titles', 'Titoli', '🏷️', 'Mostra solo la gerarchia dei titoli H1..H6');
    mkDetailBtn('keypoints', 'Punti Chiave', '🎯', 'Mostra titoli e punti chiave salienti');
    mkDetailBtn('full', 'Tutto', '📖', 'Mostra anche il testo completo dei paragrafi');

    // GRUPPO 3: STRUMENTI & NAVIGAZIONE
    const groupTools = this.topDock.createDiv({ cls: 'cds-mm-dock-group' });

    const mkToolBtn = (icon, tip, onClick) => {
      const b = groupTools.createEl('button', { cls: 'cds-mm-dock-btn', attr: { title: tip } });
      b.innerHTML = icon;
      b.onmousedown = (e) => e.stopPropagation();
      b.onclick = (e) => { e.stopPropagation(); onClick(); };
      return b;
    };

    mkToolBtn('➕ <span class="cds-mm-btn-text">Figlio</span>', 'Aggiungi Nodo Figlio (Tab)', () => this.addChildToSelected());
    mkToolBtn('⏬ <span class="cds-mm-btn-text">Fratello</span>', 'Aggiungi Nodo Fratello (Enter)', () => this.addSiblingToSelected());
    mkToolBtn('🗑️', 'Elimina Nodo Selezionato (Canc)', () => this.deleteSelected());

    groupTools.createDiv({ cls: 'cds-mm-divider' });

    mkToolBtn('🔍 Adatta', 'Visualizza Intera Mappa nello Schermo (Fit-All)', () => this.fitToScreen());
    mkToolBtn('🧭 Centra', 'Centra la radice della mappa (Ctrl+E)', () => this.centerRoot());
    mkToolBtn('🔄 Reset', 'Reimposta posizioni automatiche', () => this.resetCustomPositions());
    mkToolBtn('🗺️', 'Attiva/Disattiva Minimap', () => this.toggleMinimap());

    groupTools.createDiv({ cls: 'cds-mm-divider' });

    mkToolBtn('📤 Esporta HD', 'Esporta nei formati da A0 ad A6 (PNG, JPG, PDF, SVG)', () => this.openExportModal());
  }

  render() {
    if (this.viewMode === 'table') {
      this.viewport.style.display = 'none';
      this.outlineContainer.style.display = 'none';
      this.tableContainer.style.display = 'block';
      this.minimapWrap.style.display = 'none';
      this.renderTableView();
      return;
    }

    if (this.viewMode === 'outline') {
      this.viewport.style.display = 'none';
      this.tableContainer.style.display = 'none';
      this.outlineContainer.style.display = 'block';
      this.minimapWrap.style.display = 'none';
      this.renderOutlineView();
      return;
    }

    this.tableContainer.style.display = 'none';
    this.outlineContainer.style.display = 'none';
    this.viewport.style.display = 'block';
    this.minimapWrap.style.display = this.showMinimap ? 'block' : 'none';

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

    while (this.svgLayer.firstChild) {
      this.svgLayer.removeChild(this.svgLayer.firstChild);
    }

    let minX = 0, minY = 0, maxX = 2800, maxY = 2400;

    for (const p of this.renderedPaths) {
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', p.d);
      pathEl.setAttribute('stroke', p.color);
      pathEl.setAttribute('class', 'cds-mm-branch-path' + (p.toId === this.selectedNodeId ? ' is-selected' : ''));
      pathEl.setAttribute('data-from', p.fromId);
      pathEl.setAttribute('data-to', p.toId);
      this.svgLayer.appendChild(pathEl);
    }

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
      nodeEl.style.borderColor = node.isRoot ? 'rgba(255,255,255,0.5)' : node.color || '#38bdf8';

      if (isSelected) selectedNodeEl = nodeEl;

      if (node.layout === 'table') {
        this.renderEmbeddedTableNode(node, nodeEl);
      } else {
        const headerRow = nodeEl.createDiv({ cls: 'cds-mm-node-header' });

        if (node.isRoot) {
          headerRow.createSpan({ text: '🗺️ Titolo Mappa', cls: 'cds-mm-root-badge' });
        } else if (node.type === 'keypoint') {
          headerRow.createSpan({ text: '🎯', cls: 'cds-mm-kp-badge' });
        } else if (node.depth === 1) {
          headerRow.createSpan({ text: '🏷️ Cap.', cls: 'cds-mm-chap-badge' });
        }

        const titleEl = headerRow.createDiv({ cls: 'cds-mm-node-title' });

        // Rich Markdown Rendering
        if (this.app && MarkdownRenderer && MarkdownRenderer.render) {
          MarkdownRenderer.render(this.app, node.text, titleEl, this.filePath, this.plugin || {});
        } else {
          titleEl.innerHTML = MindmapEngine.renderMiniMarkdown(node.text);
        }

        // Miniatura Immagine se presente
        if (node.images && node.images.length) {
          const imgWrap = nodeEl.createDiv({ cls: 'cds-mm-node-img-wrap' });
          for (const img of node.images) {
            let src = img.path;
            if (img.type === 'vault' && this.app) {
              const f = this.app.metadataCache.getFirstLinkpathDest(img.path, this.filePath);
              if (f) src = this.app.vault.getResourcePath(f);
            }
            const imgEl = imgWrap.createEl('img', { cls: 'cds-mm-node-thumb', attr: { src } });
            imgEl.onclick = (ev) => {
              ev.stopPropagation();
              window.open(src, '_blank');
            };
          }
        }

        // Testo di paragrafo
        if (node.bodyText) {
          if (this.detailLevel === 'full' || this.expandedNodes.has(node.id)) {
            const bodyEl = nodeEl.createDiv({ cls: 'cds-mm-node-body' });
            bodyEl.innerHTML = MindmapEngine.renderMiniMarkdown(node.bodyText);
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

        // Badge PDF
        if (node.pdfLink) {
          const badge = nodeEl.createDiv({ cls: 'cds-mm-pdf-badge' });
          badge.innerHTML = `📄 <b>${node.pdfLink.file}</b> · Pag. ${node.pdfLink.page}`;
          badge.onmousedown = (ev) => ev.stopPropagation();
          badge.onclick = (ev) => {
            ev.stopPropagation();
            if (this.options.onPdfJump) this.options.onPdfJump(node.pdfLink);
          };
        }

        // Fold button
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

      // Eventi di click e inizio Drag Libero
      nodeEl.onmousedown = (ev) => {
        ev.stopPropagation();
        this.selectNode(node.id);

        // Se clicco in un nodo, evidenzia quel punto della nota markdown!
        if (this.options.onNodeClick) {
          this.options.onNodeClick(node);
        }

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

    this.updateFloatingBar(selectedNodeEl);
    this.updateTransform();
    this.updateMinimap();
  }

  renderEmbeddedTableNode(node, nodeEl) {
    const topBar = nodeEl.createDiv({ cls: 'cds-mm-table-node-top' });
    topBar.createSpan({ cls: 'cds-mm-table-node-title', text: node.text });

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

    const bAddRow = tools.createEl('button', { cls: 'cds-mm-mini-btn', text: '+ Riga', attr: { title: 'Aggiungi nuova riga' } });
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
    mkFloatBtn(isTable ? '🧠 Mappa' : '📊 Tabella', isTable ? 'Ritorna a Ramo Mappa' : 'Converti in Tabella', () => this.toggleTableLayoutSelected());

    mkFloatBtn('📷 Foto', 'Inserisci Immagine nel nodo', () => this.promptInsertImage(rawNode));
    mkFloatBtn('📄 PDF', 'Collega Documento PDF', () => this.promptInsertPdf(rawNode));
    mkFloatBtn('🔗 Link', 'Inserisci Collegamento Esterno', () => this.promptInsertLink(rawNode));

    mkFloatBtn('✏️', 'Modifica Testo (F2)', () => this.startEditing(rawNode, selectedEl));
    mkFloatBtn('🗑️', 'Elimina Nodo (Canc)', () => this.deleteSelected());

    const nodeX = parseFloat(selectedEl.style.left) || 0;
    const nodeY = parseFloat(selectedEl.style.top) || 0;
    const nodeW = parseFloat(selectedEl.style.width) || 160;

    this.floatingBar.style.left = `${nodeX + (nodeW / 2)}px`;
    this.floatingBar.style.top = `${nodeY - 14}px`;
  }

  // ==========================================================================
  // INSERIMENTO MEDIA (FOTO, PDF, LINK)
  // ==========================================================================
  promptInsertImage(node) {
    const input = prompt('Inserisci il nome del file immagine nel vault (es: schema.png) o un URL web:');
    if (!input || !input.trim()) return;
    const clean = input.trim();
    if (clean.startsWith('http')) {
      node.text += ` ![immagine](${clean})`;
    } else {
      node.text += ` ![[${clean}]]`;
    }
    this.render();
    this.triggerSave();
    new Notice('📷 Immagine inserita nel nodo!');
  }

  promptInsertPdf(node) {
    const fileName = prompt('Nome del documento PDF nel vault (es: Relazione.pdf):');
    if (!fileName || !fileName.trim()) return;
    const page = prompt('Numero di pagina:', '1');
    const clean = fileName.trim();
    const pNum = parseInt(page || '1', 10) || 1;
    node.text += ` [[${clean}#page=${pNum}|📄 Pag. ${pNum}]]`;
    this.render();
    this.triggerSave();
    new Notice('📄 Collegamento PDF aggiunto!');
  }

  promptInsertLink(node) {
    const url = prompt('Inserisci URL esterno (es: https://esempio.com):');
    if (!url || !url.trim()) return;
    const label = prompt('Testo del link:', 'Sito Web');
    node.text += ` [${label || 'Link'}](${url.trim()})`;
    this.render();
    this.triggerSave();
    new Notice('🔗 Collegamento esterno inserito!');
  }

  // ==========================================================================
  // MINIMAP E FIT-TO-SCREEN
  // ==========================================================================
  setupMinimapEvents() {
    this.minimapWrap.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      this.panWithMinimap(e);
    });
  }

  toggleMinimap() {
    this.showMinimap = !this.showMinimap;
    this.minimapWrap.style.display = this.showMinimap ? 'block' : 'none';
    if (this.showMinimap) this.updateMinimap();
  }

  updateMinimap() {
    if (!this.showMinimap || !this.renderedNodes || !this.renderedNodes.length) return;

    const ctx = this.minimapCanvas.getContext('2d');
    const mW = this.minimapCanvas.width;
    const mH = this.minimapCanvas.height;

    ctx.clearRect(0, 0, mW, mH);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fillRect(0, 0, mW, mH);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.renderedNodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.width > maxX) maxX = n.x + n.width;
      if (n.y + n.height > maxY) maxY = n.y + n.height;
    }

    const padding = 40;
    const mapW = Math.max(100, (maxX - minX) + padding * 2);
    const mapH = Math.max(100, (maxY - minY) + padding * 2);

    const scale = Math.min(mW / mapW, mH / mapH);

    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(padding - minX, padding - minY);

    for (const p of this.renderedPaths || []) {
      ctx.strokeStyle = p.color || '#38bdf8';
      ctx.lineWidth = 2.5;
      const path2d = new Path2D(p.d);
      ctx.stroke(path2d);
    }

    for (const n of this.renderedNodes) {
      ctx.fillStyle = n.isRoot ? '#2563eb' : (n.color || '#38bdf8');
      ctx.fillRect(n.x, n.y, n.width, n.height);
    }

    ctx.restore();

    // Disegna il riquadro della vista attuale (lens)
    const vW = this.viewport.clientWidth || 1000;
    const vH = this.viewport.clientHeight || 700;

    const visibleLeft = (-this.panX / this.zoom);
    const visibleTop = (-this.panY / this.zoom);
    const visibleW = (vW / this.zoom);
    const visibleH = (vH / this.zoom);

    const lensX = ((visibleLeft - minX + padding) * scale);
    const lensY = ((visibleTop - minY + padding) * scale);
    const lensW = Math.max(10, visibleW * scale);
    const lensH = Math.max(10, visibleH * scale);

    this.minimapLens.style.left = `${Math.max(0, Math.min(mW - 10, lensX))}px`;
    this.minimapLens.style.top = `${Math.max(0, Math.min(mH - 10, lensY))}px`;
    this.minimapLens.style.width = `${Math.min(mW, lensW)}px`;
    this.minimapLens.style.height = `${Math.min(mH, lensH)}px`;
  }

  panWithMinimap(e) {
    const rect = this.minimapWrap.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.renderedNodes || []) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.width > maxX) maxX = n.x + n.width;
      if (n.y + n.height > maxY) maxY = n.y + n.height;
    }

    const padding = 40;
    const mapW = Math.max(100, (maxX - minX) + padding * 2);
    const mapH = Math.max(100, (maxY - minY) + padding * 2);
    const scale = Math.min(this.minimapCanvas.width / mapW, this.minimapCanvas.height / mapH);

    const targetMapX = (clickX / scale) + minX - padding;
    const targetMapY = (clickY / scale) + minY - padding;

    const vW = this.viewport.clientWidth || 1000;
    const vH = this.viewport.clientHeight || 700;

    this.panX = (vW / 2) - (targetMapX * this.zoom);
    this.panY = (vH / 2) - (targetMapY * this.zoom);
    this.updateTransform();
    this.updateMinimap();
  }

  fitToScreen() {
    if (!this.renderedNodes || !this.renderedNodes.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.renderedNodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.width > maxX) maxX = n.x + n.width;
      if (n.y + n.height > maxY) maxY = n.y + n.height;
    }

    const vW = this.viewport.clientWidth || 1000;
    const vH = this.viewport.clientHeight || 700;
    const padding = 80;

    const mapW = Math.max(100, (maxX - minX));
    const mapH = Math.max(100, (maxY - minY));

    const scaleX = (vW - padding * 2) / mapW;
    const scaleY = (vH - padding * 2) / mapH;
    this.zoom = Math.max(0.18, Math.min(1.4, Math.min(scaleX, scaleY)));

    const mapCenterX = minX + (mapW / 2);
    const mapCenterY = minY + (mapH / 2);

    this.panX = (vW / 2) - (mapCenterX * this.zoom);
    this.panY = (vH / 2) - (mapCenterY * this.zoom);

    this.updateTransform();
    this.updateMinimap();
    new Notice('🔍 Visualizzazione intera mappa adattata allo schermo');
  }

  openExportModal() {
    new MindmapExportModal(this.app, this).open();
  }

  // ==========================================================================
  // DRAG AND DROP LIBERO
  // ==========================================================================
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
    if (this.isDraggingCanvas) {
      this.panX = ev.clientX - this.dragStart.x;
      this.panY = ev.clientY - this.dragStart.y;
      this.updateTransform();
      this.updateMinimap();
      return;
    }

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

        for (const desc of s.descendants) {
          desc.node.x = desc.origX + dx;
          desc.node.y = desc.origY + dy;
          const el = this.nodesLayer.querySelector(`[data-node-id="${desc.node.id}"]`);
          if (el) {
            el.style.left = `${desc.node.x}px`;
            el.style.top = `${desc.node.y}px`;
          }
        }

        this.updateBranchPathsRealtime();

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

              delete s.rawNode.customX;
              delete s.rawNode.customY;

              new Notice(`Spostato "${s.rawNode.text.slice(0, 20)}" sotto "${newParent.text.slice(0, 20)}"`);
              this.render();
              this.triggerSave();
              return;
            }
          }
        }

        s.rawNode.customX = s.node.x;
        s.rawNode.customY = s.node.y;

        for (const desc of s.descendants) {
          if (desc.rawNode) {
            desc.rawNode.customX = desc.node.x;
            desc.rawNode.customY = desc.node.y;
          }
        }

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

    input.style.left = `${node.x}px`;
    input.style.top = `${node.y}px`;
    input.style.width = `${Math.max(node.width, 220)}px`;
    input.style.height = `${Math.max(node.height, 60)}px`;

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
    if (e.target.closest('.cds-mm-node') || e.target.closest('.cds-mm-top-dock') || e.target.closest('.cds-mm-floating-bar') || e.target.closest('.cds-mm-minimap')) return;
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
      this.updateMinimap();
    }
  }

  updateTransform() {
    this.stage.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  setZoom(val) {
    this.zoom = Math.max(0.2, Math.min(3.0, val));
    this.updateTransform();
    this.updateMinimap();
  }

  centerRoot() {
    const vW = this.viewport.clientWidth || 1000;
    const vH = this.viewport.clientHeight || 700;

    if (this.viewMode === 'radial') {
      this.panX = (vW / 2) - 1500;
      this.panY = (vH / 2) - 1200;
    } else if (this.viewMode === 'bilateral') {
      this.panX = (vW / 2) - 1100 - (this.rawRootNode.width / 2);
      this.panY = (vH / 2) - 300 - (this.rawRootNode.height / 2);
    } else {
      this.panX = Math.max(60, vW * 0.1);
      this.panY = Math.max(60, (vH / 2) - 150);
    }
    this.zoom = 1;
    this.updateTransform();
    this.updateMinimap();
  }

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
      row.createEl('td', { text: 'Nessun capitolo presente.', attr: { colspan: 4, style: 'text-align:center;color:#94a3b8;padding:24px;' } });
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

          if (sIdx === 0 && kIdx === 0) {
            const tdChap = tr.createEl('td', { attr: { rowspan: sections.reduce((acc, s) => acc + (s.children && s.children.length ? s.children.length : 1), 0) } });
            tdChap.style.fontWeight = '700';
            tdChap.style.color = '#38bdf8';
            const cell = tdChap.createDiv({ cls: 'cds-mm-table-cell', text: chap.text });
            cell.contentEditable = 'true';
            cell.onblur = () => { chap.text = cell.textContent.trim(); this.triggerSave(); };
          }

          if (kIdx === 0) {
            const tdSec = tr.createEl('td', { attr: { rowspan: kp ? (sec.children && sec.children.length ? sec.children.length : 1) : 1 } });
            tdSec.style.fontWeight = '600';
            const cell = tdSec.createDiv({ cls: 'cds-mm-table-cell', text: sec.text });
            cell.contentEditable = 'true';
            cell.onblur = () => { sec.text = cell.textContent.trim(); this.triggerSave(); };
          }

          const tdKp = tr.createEl('td');
          const cellKp = tdKp.createDiv({ cls: 'cds-mm-table-cell', text: kp.text });
          cellKp.contentEditable = 'true';
          cellKp.onblur = () => { kp.text = cellKp.textContent.trim(); this.triggerSave(); };

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
}

// ==========================================================================
// 4. CdsMindmapView: Vista Obsidian con Salto Bidirezionale Nota ➔ Mappa
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
      app: this.app,
      plugin: this.plugin,
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
      },
      onNodeClick: (node) => {
        this.jumpToNodeInMarkdown(node);
      }
    });

    this.canvas.centerRoot();
  }

  /**
   * Salto ed evidenziazione riga nella nota affiancata quando si clicca un nodo
   */
  jumpToNodeInMarkdown(node) {
    if (!this.file) return;
    const mdLeaves = this.app.workspace.getLeavesOfType('markdown');
    const targetLeaf = mdLeaves.find(l => l.view && l.view.file && l.view.file.path === this.file.path);
    if (!targetLeaf || !targetLeaf.view || !targetLeaf.view.editor) return;

    const editor = targetLeaf.view.editor;
    const lineCount = editor.lineCount();
    let targetLine = -1;

    if (node.sourceLine !== undefined && node.sourceLine >= 0 && node.sourceLine < lineCount) {
      targetLine = node.sourceLine;
    } else {
      const search = (node.text || '').replace(/[#*`~\[\]]/g, '').trim().toLowerCase().slice(0, 20);
      for (let i = 0; i < lineCount; i++) {
        if (editor.getLine(i).toLowerCase().includes(search)) {
          targetLine = i;
          break;
        }
      }
    }

    if (targetLine !== -1) {
      editor.setCursor({ line: targetLine, ch: 0 });
      editor.scrollIntoView({ from: { line: Math.max(0, targetLine - 2), ch: 0 }, to: { line: targetLine + 2, ch: 0 } }, true);

      // Flash highlight visivo nell'editor
      const viewEl = targetLeaf.view.containerEl;
      const flashEl = viewEl.createDiv({ cls: 'cds-mm-editor-flash' });
      flashEl.style.cssText = 'position:absolute;top:0;left:0;right:0;height:30px;background:rgba(56,189,248,0.25);border-left:4px solid #38bdf8;pointer-events:none;z-index:99;transition:opacity 0.6s ease;';
      setTimeout(() => {
        flashEl.style.opacity = '0';
        setTimeout(() => flashEl.remove(), 600);
      }, 1000);
    }
  }

  async reloadFromMarkdown() {
    if (!this.file || !this.canvas || this._isInternalSaving) return;
    const content = await this.app.vault.read(this.file);
    const newRoot = MindmapEngine.parseMarkdown(content, this.file.basename, this.file.path);

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
// 5. CdsMindmapPlugin: Lifecycle
// ==========================================================================

module.exports = class CdsMindmapPlugin extends Plugin {
  async onload() {
    console.log('Loading CDS Mindmap Suite v1.3.0 (Rich Markdown, Fit-All, Minimap & A0-A6 Export)');

    this.registerView(VIEW_TYPE_MINDMAP, (leaf) => new CdsMindmapView(leaf, this));

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

    this.addRibbonIcon('git-fork', 'CDS Mindmap: Apri come Mappa Concettuale', () => {
      this.openActiveNoteAsMindmap();
    });

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

    // Codeblocks
    const codeblockHandler = (source, el, ctx) => {
      el.empty();
      const wrap = el.createDiv({ cls: 'cds-mm-codeblock' });
      const rootNode = MindmapEngine.parseMarkdown(source, 'Mappa Concettuale');

      new MindmapCanvas(wrap, {
        rootNode,
        app: this.app,
        plugin: this,
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
