const { Plugin, ItemView, WorkspaceLeaf, Notice, TFile, Modal } = require('obsidian');

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
  Auto: { label: 'Adattivo (Mappa)', w: 0, h: 0 },
  A0: { label: 'A0 (841 × 1189 mm)', w: 841, h: 1189 },
  A1: { label: 'A1 (594 × 841 mm)', w: 594, h: 841 },
  A2: { label: 'A2 (420 × 594 mm)', w: 420, h: 594 },
  A3: { label: 'A3 (297 × 420 mm)', w: 297, h: 420 },
  A4: { label: 'A4 (210 × 297 mm)', w: 210, h: 297 },
  A5: { label: 'A5 (148 × 210 mm)', w: 148, h: 210 },
  A6: { label: 'A6 (105 × 148 mm)', w: 105, h: 148 }
};

const CUSTOM_POSITIONS_CACHE = new Map();

// ==========================================================================
// 1. MindmapEngine: Parser, Serializer, Filtro Dettaglio, Rich MD & Multi-Layout
// ==========================================================================

class MindmapEngine {
  static generateBranchPath(x1, y1, x2, y2, isRight, style = 'curved') {
    if (style === 'orthogonal') {
      const midX = Math.round((x1 + x2) / 2);
      return `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
    }
    if (style === 'straight') {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    const dx = Math.abs(x2 - x1) * 0.55;
    return isRight
      ? `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
  }

  static generateDeterministicId(parentPath, index, text) {
    const clean = (text || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
    return parentPath ? `${parentPath}_${index}_${clean}` : 'root';
  }

    /**
   * Rendering sincrono, immediato e infallibile di Markdown per i nodi
   */
  static renderMiniMarkdown(text) {
    if (!text) return '';
    let res = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.*?)\*/g, '<i>$1</i>')
      .replace(/==(.*?)==/g, '<mark class="cds-mm-mark">$1</mark>')
      .replace(/`([^`]+)`/g, '<code class="cds-mm-code">$1</code>')
      .replace(/\[\[(.*?)\|(.*?)\]\]/g, '<span class="cds-mm-wikilink" data-target="$1">$2</span>')
      .replace(/\[\[(.*?)\]\]/g, '<span class="cds-mm-wikilink" data-target="$1">$1</span>')
      .replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="cds-mm-ext-link">$1 ↗</a>')
      .replace(/\[\^([^\]]+)\]/g, '<sup class="cds-mm-footnote" data-footnote="$1">[$1]</sup>');
    return res;
  }

  static extractImages(text) {
    const images = [];
    if (!text) return images;

    const wikiImgRegex = /!\[\[([^\]]+\.(?:png|jpg|jpeg|gif|webp|svg))\]\]/gi;
    let m;
    while ((m = wikiImgRegex.exec(text)) !== null) {
      images.push({ type: 'vault', path: m[1].trim() });
    }

    const mdImgRegex = /!\[.*?\]\(((?:https?:\/\/|file:\/\/|app:\/\/)[^\s)]+)\)/gi;
    while ((m = mdImgRegex.exec(text)) !== null) {
      images.push({ type: 'url', path: m[1].trim() });
    }

    return images;
  }

  /**
   * Parser avanzato per Tabelle Box-Drawing Unicode (┌─┬┐, │, ├┼┤, └┴┘)
   */
  static parseBoxDrawingTable(lines) {
    if (!lines || lines.length < 2) return null;
    const tableLines = lines.filter(l => {
      const t = l.trim();
      return (t.startsWith('│') && t.endsWith('│')) || /^[┌├└]/.test(t);
    });
    if (tableLines.length < 2) return null;

    const contentLines = tableLines.filter(l => l.trim().startsWith('│') && l.trim().endsWith('│'));
    if (contentLines.length === 0) return null;

    let title = '';
    let headers = [];
    const rows = [];

    for (let i = 0; i < contentLines.length; i++) {
      const raw = contentLines[i].trim();
      const inner = raw.slice(1, -1);
      const cells = inner.split('│').map(c => c.trim());

      if (i === 0 && cells.length === 1 && !cells[0].includes('•')) {
        title = cells[0];
      } else if (headers.length === 0 && cells.length > 1) {
        headers = cells;
      } else {
        rows.push(cells);
      }
    }

    if (headers.length === 0 && rows.length > 0) {
      headers = rows.shift();
    }

    return { title, headers, rows };
  }

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

    // 1. Scansione preliminare H1
    const h1List = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const m = lines[idx].match(/^#\s+(.*)$/);
      if (m) h1List.push({ lineIndex: idx, text: m[1].trim() });
    }

    let docTitle = fallbackTitle;
    let skipFirstH1 = false;
    const cleanFn = (fallbackTitle || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    if (h1List.length >= 1) {
      const cleanFirstH1 = h1List[0].text.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cleanFirstH1 === cleanFn || cleanFirstH1.includes(cleanFn) || cleanFn.includes(cleanFirstH1)) {
        docTitle = h1List[0].text;
        skipFirstH1 = true;
      } else if (h1List.length === 1) {
        const isChapterLike = /(?:capitolo|chapter|cap\.|sezione|modulo|\b[ivxlcdm]+\b)/i.test(h1List[0].text);
        if (!isChapterLike) {
          docTitle = h1List[0].text;
          skipFirstH1 = true;
        }
      }
    }

    const rootNode = {
      id: 'root',
      text: docTitle,
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

    const fileCache = filePath ? CUSTOM_POSITIONS_CACHE.get(filePath) || {} : {};

    let activeTable = null; // Buffer per tabelle

    for (let i = 0; i < lines.length; i++) {
      const lineNum = lineOffset + i;
      const line = lines[i];
      const trimmed = line.trim();

      // Rilevamento righe di tabella (Markdown | o Box-Drawing ┌│├└)
      const isMdTable = trimmed.startsWith('|') && trimmed.endsWith('|');
      const isBoxTable = /^[┌│├└]/.test(trimmed) || (trimmed.startsWith('```') && lines[i+1] && /^[┌│]/.test(lines[i+1].trim()));

      if (isMdTable || isBoxTable || (activeTable && trimmed.startsWith('```'))) {
        const parent = currentParentStack[currentParentStack.length - 1];
        if (!activeTable && parent) {
          activeTable = { parent, startLine: lineNum, rawLines: [] };
        }
        if (activeTable) {
          if (!trimmed.startsWith('```')) activeTable.rawLines.push(line);
          continue;
        }
      } else if (activeTable) {
        // Chiusura e finalizzazione tabella come Ramo Figlio Dedicato
        const t = activeTable;
        activeTable = null;

        let tableData = null;
        if (t.rawLines.some(l => /^[┌│├└]/.test(l.trim()))) {
          tableData = MindmapEngine.parseBoxDrawingTable(t.rawLines);
        } else {
          const validLines = t.rawLines.filter(l => l.trim().startsWith('|') && l.trim().endsWith('|'));
          const headers = [];
          const rows = [];
          for (const vl of validLines) {
            const cells = vl.split('|').slice(1, -1).map(c => c.trim());
            if (cells.every(c => /^[-:\s]+$/.test(c))) continue;
            if (headers.length === 0) headers.push(...cells);
            else rows.push(cells);
          }
          tableData = { title: '', headers, rows };
        }

        if (tableData && (tableData.headers.length > 0 || tableData.rows.length > 0)) {
          const tblTitle = tableData.title || (tableData.headers[0] ? `Tabella: ${tableData.headers[0]}` : 'Tabella di Sintesi');
          const childIdx = t.parent.children.length;
          const tableNode = {
            id: `${t.parent.id}_tbl_${childIdx}`,
            text: `📊 ${tblTitle.slice(0, 36)}`,
            depth: (t.parent.depth || 1) + 1,
            type: 'table',
            layout: 'table',
            tableData,
            children: [],
            collapsed: false,
            sourceLine: t.startLine
          };
          t.parent.children.push(tableNode);
        }
      }

      if (!trimmed) continue;

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

      const images = MindmapEngine.extractImages(trimmed);

      const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        const text = hMatch[2].trim();

        if (skipFirstH1 && level === 1 && i === h1List[0].lineIndex) {
          rootNode.sourceLine = lineNum;
          continue;
        }

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
          if (fileCache[nodeId].customWidth) node.customWidth = fileCache[nodeId].customWidth;
          if (fileCache[nodeId].customHeight) node.customHeight = fileCache[nodeId].customHeight;
          if (fileCache[nodeId].edgeText) node.edgeText = fileCache[nodeId].edgeText;
          if (fileCache[nodeId].isOrganic) node.isOrganic = fileCache[nodeId].isOrganic;
        }

        parent.children.push(node);
        currentParentStack.push(node);
        pathStack.push(`h${childIdx}`);
        continue;
      }

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
          if (fileCache[nodeId].customWidth) node.customWidth = fileCache[nodeId].customWidth;
          if (fileCache[nodeId].customHeight) node.customHeight = fileCache[nodeId].customHeight;
          if (fileCache[nodeId].edgeText) node.edgeText = fileCache[nodeId].edgeText;
          if (fileCache[nodeId].isOrganic) node.isOrganic = fileCache[nodeId].isOrganic;
        }

        parent.children.push(node);
        currentParentStack.push(node);
        pathStack.push(`k${childIdx}`);
        continue;
      }

      // Paragrafi
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
          const hasTableInBody = child.bodyText && (/\|.*\|/.test(child.bodyText) || /^[┌│]/.test(child.bodyText.trim()));
          if (!hasTableInBody && child.tableData && child.tableData.headers && child.tableData.headers.length) {
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

  /**
   * Sistema Anticonflitto / Anti-sovrapposizione dei Nodi:
   * I nodi non possono sovrapporsi, mantengono ordine verticale ed elegante spaziatura.
   */
  static resolveCollisions(nodes, minGapX = 45, minGapY = 34) {
    if (!nodes || nodes.length < 2) return;

    const root = nodes.find(n => n.isRoot);
    const rootPadX = 60;
    const rootPadY = 40;

    for (let iter = 0; iter < 45; iter++) {
      let hadCollision = false;

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (a.isRoot) continue;

        // Evita sovrapposizione con il nodo Root
        if (root) {
          const ovRootX = Math.min(a.x + a.width, root.x + root.width + rootPadX) - Math.max(a.x, root.x - rootPadX);
          const ovRootY = Math.min(a.y + a.height, root.y + root.height + rootPadY) - Math.max(a.y, root.y - rootPadY);
          if (ovRootX > 0 && ovRootY > 0) {
            if (a.x >= root.x + (root.width / 2)) {
              a.x = root.x + root.width + rootPadX + 16;
            } else {
              a.x = root.x - a.width - rootPadX - 16;
            }
            hadCollision = true;
          }
        }

        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          if (b.isRoot) continue;

          const aRight = a.x + a.width;
          const aBottom = a.y + a.height;
          const bRight = b.x + b.width;
          const bBottom = b.y + b.height;

          const ovX = Math.min(aRight + minGapX, bRight + minGapX) - Math.max(a.x, b.x);
          const ovY = Math.min(aBottom + minGapY, bBottom + minGapY) - Math.max(a.y, b.y);

          if (ovX > 0 && ovY > 0) {
            hadCollision = true;

            const xOverlap = Math.min(aRight, bRight) - Math.max(a.x, b.x);
            if (xOverlap > 20) {
              if (a.y <= b.y) {
                const pushY = (aBottom + minGapY) - b.y;
                b.y += pushY;
                if (b.customY !== undefined) b.customY += pushY;
              } else {
                const pushY = (bBottom + minGapY) - a.y;
                a.y += pushY;
                if (a.customY !== undefined) a.customY += pushY;
              }
            } else {
              if (a.x <= b.x) {
                const pushX = (aRight + minGapX) - b.x;
                b.x += pushX;
                if (b.customX !== undefined) b.customX += pushX;
              } else {
                const pushX = (bRight + minGapX) - a.x;
                a.x += pushX;
                if (a.customX !== undefined) a.customX += pushX;
              }
            }
          }
        }
      }

      if (!hadCollision) break;
    }
  }

  static measureNode(node, detailLevel = 'keypoints') {
    const text = node.text || '';
    const cleanText = text.replace(/\[\[.*?\]\]/g, 'Link').replace(/\*\*|==|\*|`/g, '');
    const rawLines = cleanText.split('\n');
    const maxLineLen = rawLines.reduce((max, l) => Math.max(max, l.length), 0);

    // Dimensionamento orizzontale generoso
    let w = Math.max(160, Math.min(420, maxLineLen * 9.5 + 54));

    // Stima accurata di word-wrapping nel DOM con font a 13-14px
    const printableWidth = Math.max(120, w - 50);
    const charsPerLine = Math.max(16, Math.floor(printableWidth / 8.2));

    let wrappedLineCount = 0;
    for (const rl of rawLines) {
      const trimmed = rl.trim();
      if (!trimmed) {
        wrappedLineCount += 1;
      } else {
        wrappedLineCount += Math.max(1, Math.ceil(trimmed.length / charsPerLine));
      }
    }
    wrappedLineCount = Math.max(1, wrappedLineCount);

    // Altezza base con padding e line-height (24px a riga + 32px padding/border)
    let h = Math.max(54, wrappedLineCount * 24 + 32);

    if (node.images && node.images.length) {
      w = Math.max(w, 260);
      h += 120;
    }

    if (node.layout === 'table') {
      w = Math.max(w, 440);
      const rowCount = (node.tableData && node.tableData.rows) ? node.tableData.rows.length : (node.children ? node.children.length : 1);
      h = Math.max(h, 110 + rowCount * 36);
    } else {
      if (detailLevel === 'full' && node.bodyText) {
        w = Math.max(w, 280);
        const bodyLines = node.bodyText.split('\n').length;
        h += Math.max(40, Math.min(180, bodyLines * 22 + 28));
      }
      if (node.pdfLink) {
        h += 28;
        w = Math.max(w, 200);
      }
    }

    // Titolo Centrale
    if (node.isRoot) {
      w = Math.max(280, Math.min(540, maxLineLen * 12 + 90));
      const rootCharsPerLine = Math.max(20, Math.floor((w - 60) / 10.5));
      const rootWrapped = Math.max(1, Math.ceil(cleanText.length / rootCharsPerLine));
      h = Math.max(76, rootWrapped * 32 + 40);
    }

    node.width = node.customWidth ? Math.max(80, node.customWidth) : w;
    node.height = node.customHeight ? Math.max(36, node.customHeight) : h;

    if (node.children && node.children.length && node.layout !== 'table') {
      for (const child of node.children) {
        MindmapEngine.measureNode(child, detailLevel);
      }
    }
  }

  static computeSubtreeHeight(node, verticalGap = 42) {
    const selfH = (node.height || 54);
    if (!node.children || !node.children.length || node.layout === 'table' || node.collapsed) {
      node.subtreeHeight = selfH + verticalGap;
      return node.subtreeHeight;
    }
    let sum = 0;
    for (const child of node.children) {
      sum += MindmapEngine.computeSubtreeHeight(child, verticalGap);
    }
    node.subtreeHeight = Math.max(selfH + verticalGap, sum);
    return node.subtreeHeight;
  }

  // ==========================================================================
  // LAYOUT 1: RADIALE 360° AD ANGOLI PROPORZIONALI (DISTANZE AMPIE E ANTI-COLLISIONE)
  static computeRadialLayout(rootNode, options = {}) {
    const detailLevel = options.detailLevel || 'keypoints';
    const horizontalGap = options.horizontalGap || 135;
    const verticalGap = options.verticalGap || 40;
    const connectorStyle = options.connectorStyle || 'curved';

    MindmapEngine.measureNode(rootNode, detailLevel);

    const cx = options.cx || 2400;
    const cy = options.cy || 1800;

    rootNode.x = cx - (rootNode.width / 2);
    rootNode.y = cy - (rootNode.height / 2);
    rootNode.color = '#38bdf8';
    rootNode.direction = 'center';

    const renderedNodes = [rootNode];
    const branchPaths = [];

    const chapters = rootNode.children || [];
    const N = chapters.length;
    if (N === 0) return { nodes: renderedNodes, paths: branchPaths, root: rootNode };

    let totalSubtreeH = 0;
    chapters.forEach(c => {
      MindmapEngine.computeSubtreeHeight(c, verticalGap);
      totalSubtreeH += (c.subtreeHeight || 120);
    });

    const baseR = Math.max(680, Math.min(1600, (totalSubtreeH / (2 * Math.PI)) * 1.55));
    const rx = baseR * 1.18;
    const ry = baseR * 0.95;

    let currentAngle = -Math.PI / 2;

    for (let i = 0; i < N; i++) {
      const chap = chapters[i];
      const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
      chap.color = color;

      const sectorAngle = (2 * Math.PI) * ((chap.subtreeHeight || 120) / totalSubtreeH);
      const angle = currentAngle + (sectorAngle / 2);
      currentAngle += sectorAngle;

      const isRight = Math.cos(angle) >= 0;
      chap.direction = isRight ? 'right' : 'left';

      if (chap.customX !== undefined && chap.customY !== undefined) {
        chap.x = chap.customX;
        chap.y = chap.customY;
      } else {
        chap.x = cx + rx * Math.cos(angle) - (isRight ? 0 : chap.width);
        chap.y = cy + ry * Math.sin(angle) - (chap.height / 2);
      }

      renderedNodes.push(chap);

      const startX = isRight ? rootNode.x + rootNode.width : rootNode.x;
      const startY = rootNode.y + (rootNode.height / 2);
      const targetX = isRight ? chap.x : chap.x + chap.width;
      const targetY = chap.y + (chap.height / 2);
      const dx = Math.abs(targetX - startX) * 0.55;

      branchPaths.push({
        d: MindmapEngine.generateBranchPath(startX, startY, targetX, targetY, isRight, connectorStyle),
        color,
        fromId: rootNode.id,
        toId: chap.id,
        edgeText: chap.edgeText || ''
      });

      MindmapEngine.positionSubChildren(chap, color, chap.direction, horizontalGap, renderedNodes, branchPaths, verticalGap, connectorStyle);
    }

    MindmapEngine.resolveCollisions(renderedNodes, 45, 34);
    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }

  // ==========================================================================
  // LAYOUT 2: BILATERALE AD AMPIA SPAZIATURA E SLAB ANTI-COLLISIONE
  // ==========================================================================
  static computeBilateralLayout(rootNode, options = {}) {
    const horizontalGap = options.horizontalGap || 135;
    const verticalGap = options.verticalGap || 42;
    const connectorStyle = options.connectorStyle || 'curved';
    const detailLevel = options.detailLevel || 'keypoints';

    MindmapEngine.measureNode(rootNode, detailLevel);

    function calcFullSubtreeHeight(n) {
      MindmapEngine.measureNode(n, detailLevel);
      if (!n.children || !n.children.length || n.layout === 'table' || n.collapsed) {
        n.subtreeHeight = (n.height || 54) + verticalGap;
        return n.subtreeHeight;
      }
      let sum = 0;
      for (const ch of n.children) {
        sum += calcFullSubtreeHeight(ch);
      }
      n.subtreeHeight = Math.max((n.height || 54) + verticalGap, sum);
      return n.subtreeHeight;
    }

    calcFullSubtreeHeight(rootNode);

    const children = rootNode.children || [];
    const rightChildren = [];
    const leftChildren = [];

    for (let i = 0; i < children.length; i++) {
      if (children[i].manualSide === 'left') leftChildren.push(children[i]);
      else if (children[i].manualSide === 'right') rightChildren.push(children[i]);
      else if (i % 2 === 0) rightChildren.push(children[i]);
      else leftChildren.push(children[i]);
    }

    const chapterGap = 65;
    let totalRightH = 0;
    rightChildren.forEach(c => totalRightH += (c.subtreeHeight + chapterGap));
    let totalLeftH = 0;
    leftChildren.forEach(c => totalLeftH += (c.subtreeHeight + chapterGap));

    const maxSideH = Math.max(totalRightH, totalLeftH, 800);
    const cx = options.cx || 2400;
    const cy = options.cy || Math.max(600, maxSideH / 2);

    rootNode.x = cx - (rootNode.width / 2);
    rootNode.y = cy - (rootNode.height / 2);
    rootNode.color = '#38bdf8';
    rootNode.direction = 'center';

    const renderedNodes = [rootNode];
    const branchPaths = [];

    function placeSlab(parent, startY, dir, color) {
      if (!parent.children || !parent.children.length || parent.layout === 'table' || parent.collapsed) return;

      let y = startY;
      const isRight = dir === 'right';

      for (const child of parent.children) {
        child.color = color;
        child.direction = dir;

        if (child.customX !== undefined && child.customY !== undefined) {
          child.x = child.customX;
          child.y = child.customY;
        } else {
          child.x = isRight ? parent.x + parent.width + horizontalGap : parent.x - child.width - horizontalGap;
          child.y = y + (child.subtreeHeight / 2) - (child.height / 2);
        }

        renderedNodes.push(child);

        const x1 = isRight ? parent.x + parent.width : parent.x;
        const y1 = parent.y + (parent.height / 2);
        const x2 = isRight ? child.x : child.x + child.width;
        const y2 = child.y + (child.height / 2);
        const dx = Math.abs(x2 - x1) * 0.55;

        branchPaths.push({
          d: MindmapEngine.generateBranchPath(x1, y1, x2, y2, isRight, connectorStyle),
          color,
          fromId: parent.id,
          toId: child.id,
          edgeText: child.edgeText || ''
        });

        placeSlab(child, y, dir, color);
        y += child.subtreeHeight;
      }
    }

    let curRightY = rootNode.y + (rootNode.height / 2) - (totalRightH / 2);
    rightChildren.forEach((chap, idx) => {
      const color = BRANCH_COLORS[idx % BRANCH_COLORS.length];
      chap.color = color;
      chap.direction = 'right';

      if (chap.customX !== undefined && chap.customY !== undefined) {
        chap.x = chap.customX;
        chap.y = chap.customY;
      } else {
        chap.x = rootNode.x + rootNode.width + horizontalGap;
        chap.y = curRightY + (chap.subtreeHeight / 2) - (chap.height / 2);
      }

      renderedNodes.push(chap);

      const x1 = rootNode.x + rootNode.width;
      const y1 = rootNode.y + (rootNode.height / 2);
      const x2 = chap.x;
      const y2 = chap.y + (chap.height / 2);
      const dx = Math.abs(x2 - x1) * 0.55;

      branchPaths.push({
        d: MindmapEngine.generateBranchPath(x1, y1, x2, y2, true, connectorStyle),
        color,
        fromId: rootNode.id,
        toId: chap.id,
        edgeText: chap.edgeText || ''
      });

      placeSlab(chap, curRightY, 'right', color);
      curRightY += chap.subtreeHeight + chapterGap;
    });

    let curLeftY = rootNode.y + (rootNode.height / 2) - (totalLeftH / 2);
    leftChildren.forEach((chap, idx) => {
      const color = BRANCH_COLORS[(idx + 4) % BRANCH_COLORS.length];
      chap.color = color;
      chap.direction = 'left';

      if (chap.customX !== undefined && chap.customY !== undefined) {
        chap.x = chap.customX;
        chap.y = chap.customY;
      } else {
        chap.x = rootNode.x - chap.width - horizontalGap;
        chap.y = curLeftY + (chap.subtreeHeight / 2) - (chap.height / 2);
      }

      renderedNodes.push(chap);

      const x1 = rootNode.x;
      const y1 = rootNode.y + (rootNode.height / 2);
      const x2 = chap.x + chap.width;
      const y2 = chap.y + (chap.height / 2);
      const dx = Math.abs(x1 - x2) * 0.55;

      branchPaths.push({
        d: MindmapEngine.generateBranchPath(x1, y1, x2, y2, false, connectorStyle),
        color,
        fromId: rootNode.id,
        toId: chap.id,
        edgeText: chap.edgeText || ''
      });

      placeSlab(chap, curLeftY, 'left', color);
      curLeftY += chap.subtreeHeight + chapterGap;
    });

    MindmapEngine.resolveCollisions(renderedNodes, 45, 34);
    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }

  // ==========================================================================
  // LAYOUT 3: A DESTRA AD AMPIA SPAZIATURA E ZERO-CONFLITTO
  // ==========================================================================
  static computeRightLayout(rootNode, options = {}) {
    const horizontalGap = options.horizontalGap || 135;
    const verticalGap = options.verticalGap || 42;
    const connectorStyle = options.connectorStyle || 'curved';
    const detailLevel = options.detailLevel || 'keypoints';

    MindmapEngine.measureNode(rootNode, detailLevel);

    function calcFullSubtreeHeight(n) {
      MindmapEngine.measureNode(n, detailLevel);
      if (!n.children || !n.children.length || n.layout === 'table' || n.collapsed) {
        n.subtreeHeight = (n.height || 54) + verticalGap;
        return n.subtreeHeight;
      }
      let sum = 0;
      for (const ch of n.children) {
        sum += calcFullSubtreeHeight(ch);
      }
      n.subtreeHeight = Math.max((n.height || 54) + verticalGap, sum);
      return n.subtreeHeight;
    }

    calcFullSubtreeHeight(rootNode);

    const chapterGap = 65;
    let totalH = 0;
    (rootNode.children || []).forEach(c => totalH += (c.subtreeHeight + chapterGap));

    rootNode.x = 120;
    rootNode.y = Math.max(300, totalH / 2);
    rootNode.color = '#38bdf8';
    rootNode.direction = 'right';

    const renderedNodes = [rootNode];
    const branchPaths = [];

    function placeSlab(parent, startY, color) {
      if (!parent.children || !parent.children.length || parent.layout === 'table' || parent.collapsed) return;

      let y = startY;
      for (const child of parent.children) {
        child.color = color;
        child.direction = 'right';

        if (child.customX !== undefined && child.customY !== undefined) {
          child.x = child.customX;
          child.y = child.customY;
        } else {
          child.x = parent.x + parent.width + horizontalGap;
          child.y = y + (child.subtreeHeight / 2) - (child.height / 2);
        }

        renderedNodes.push(child);

        const x1 = parent.x + parent.width;
        const y1 = parent.y + (parent.height / 2);
        const x2 = child.x;
        const y2 = child.y + (child.height / 2);
        const dx = Math.abs(x2 - x1) * 0.55;

        branchPaths.push({
          d: MindmapEngine.generateBranchPath(x1, y1, x2, y2, true, connectorStyle),
          color,
          fromId: parent.id,
          toId: child.id,
          edgeText: child.edgeText || ''
        });

        placeSlab(child, y, color);
        y += child.subtreeHeight;
      }
    }

    let curY = rootNode.y + (rootNode.height / 2) - (totalH / 2);
    (rootNode.children || []).forEach((chap, idx) => {
      const color = BRANCH_COLORS[idx % BRANCH_COLORS.length];
      chap.color = color;
      chap.direction = 'right';

      if (chap.customX !== undefined && chap.customY !== undefined) {
        chap.x = chap.customX;
        chap.y = chap.customY;
      } else {
        chap.x = rootNode.x + rootNode.width + horizontalGap;
        chap.y = curY + (chap.subtreeHeight / 2) - (chap.height / 2);
      }

      renderedNodes.push(chap);

      const x1 = rootNode.x + rootNode.width;
      const y1 = rootNode.y + (rootNode.height / 2);
      const x2 = chap.x;
      const y2 = chap.y + (chap.height / 2);
      const dx = Math.abs(x2 - x1) * 0.55;

      branchPaths.push({
        d: MindmapEngine.generateBranchPath(x1, y1, x2, y2, true, connectorStyle),
        color,
        fromId: rootNode.id,
        toId: chap.id,
        edgeText: chap.edgeText || ''
      });

      placeSlab(chap, curY, color);
      curY += chap.subtreeHeight + chapterGap;
    });

    MindmapEngine.resolveCollisions(renderedNodes, 45, 34);
    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }

  static positionSubChildren(parent, color, direction, horizontalGap, renderedNodes, branchPaths, verticalGap = 40, connectorStyle = 'curved') {
    if (!parent.children || !parent.children.length || parent.layout === 'table' || parent.collapsed) return;

    let startY = parent.y + (parent.height / 2) - (parent.subtreeHeight / 2);
    const isRight = direction === 'right';

    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i];
      child.color = color;
      child.direction = direction;

      if (child.customX !== undefined && child.customY !== undefined) {
        child.x = child.customX;
        child.y = child.customY;
      } else {
        child.x = isRight ? parent.x + parent.width + horizontalGap : parent.x - child.width - horizontalGap;
        child.y = startY + (child.subtreeHeight / 2) - (child.height / 2);
      }

      renderedNodes.push(child);

      const startX = isRight ? parent.x + parent.width : parent.x;
      const startYPoint = parent.y + (parent.height / 2);
      const targetX = isRight ? child.x : child.x + child.width;
      const targetYPoint = child.y + (child.height / 2);
      const dx = Math.abs(targetX - startX) * 0.55;

      branchPaths.push({
        d: MindmapEngine.generateBranchPath(startX, startYPoint, targetX, targetYPoint, isRight, connectorStyle),
        color,
        fromId: parent.id,
        toId: child.id,
        edgeText: child.edgeText || ''
      });

      startY += child.subtreeHeight;

      if (child.layout !== 'table') {
        MindmapEngine.positionSubChildren(child, color, direction, horizontalGap, renderedNodes, branchPaths, verticalGap, connectorStyle);
      }
    }
  }
}

// ==========================================================================
// 2. MindmapExportModal: Anteprima Live Spaziosa ed Esportazione Vettoriale
// ==========================================================================


class NodeImageModal extends Modal {
  constructor(app, node, onInsert) {
    super(app);
    this.node = node;
    this.onInsert = onInsert;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '📷 Inserisci Foto / Immagine nel Nodo' });

    contentEl.createEl('p', { text: 'Nodo: "' + (this.node.text || '').slice(0, 35) + '..."', cls: 'cds-mm-modal-sub' });

    const lbl = contentEl.createEl('label', { text: 'File Immagine nel Vault o URL Web:' });
    lbl.style.display = 'block';
    lbl.style.marginTop = '12px';
    const inp = contentEl.createEl('input', { type: 'text', placeholder: 'es: schema.png oppure https://...' });
    inp.style.width = '100%';
    inp.style.marginBottom = '12px';

    const imgFiles = this.app.vault.getFiles ? this.app.vault.getFiles().filter(f => ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'].includes(f.extension.toLowerCase())) : [];
    if (imgFiles.length > 0) {
      const selectLbl = contentEl.createEl('label', { text: 'Oppure scegli un\'immagine dal tuo Vault:' });
      selectLbl.style.display = 'block';
      const select = contentEl.createEl('select');
      select.style.width = '100%';
      select.style.marginBottom = '16px';
      select.createEl('option', { value: '', text: '-- Seleziona file dal vault --' });
      imgFiles.slice(0, 50).forEach(f => {
        select.createEl('option', { value: f.path, text: f.name });
      });
      select.onchange = () => {
        if (select.value) inp.value = select.value;
      };
    }

    const btnWrap = contentEl.createDiv({ cls: 'modal-button-container' });
    const btnCancel = btnWrap.createEl('button', { text: 'Annulla' });
    btnCancel.onclick = () => this.close();

    const btnSubmit = btnWrap.createEl('button', { text: 'Inserisci Immagine', cls: 'mod-cta' });
    btnSubmit.onclick = () => {
      const val = inp.value.trim();
      if (!val) {
        new Notice('Inserisci un percorso o URL valido!');
        return;
      }
      this.onInsert(val);
      this.close();
    };

    setTimeout(() => inp.focus(), 50);
  }
}

class NodePdfModal extends Modal {
  constructor(app, node, onInsert) {
    super(app);
    this.node = node;
    this.onInsert = onInsert;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '📄 Collega Documento PDF al Nodo' });

    contentEl.createEl('p', { text: 'Nodo: "' + (this.node.text || '').slice(0, 35) + '..."', cls: 'cds-mm-modal-sub' });

    const lbl = contentEl.createEl('label', { text: 'Nome o Percorso del File PDF nel Vault:' });
    lbl.style.display = 'block';
    lbl.style.marginTop = '12px';
    const inp = contentEl.createEl('input', { type: 'text', placeholder: 'es: 1-20 Composizione completo.pdf' });
    inp.style.width = '100%';
    inp.style.marginBottom = '12px';

    const pdfFiles = this.app.vault.getFiles ? this.app.vault.getFiles().filter(f => f.extension.toLowerCase() === 'pdf') : [];
    if (pdfFiles.length > 0) {
      const select = contentEl.createEl('select');
      select.style.width = '100%';
      select.style.marginBottom = '12px';
      select.createEl('option', { value: '', text: '-- Scegli un PDF dal Vault --' });
      pdfFiles.forEach(f => {
        select.createEl('option', { value: f.path, text: f.name });
      });
      select.onchange = () => {
        if (select.value) inp.value = select.value;
      };
    }

    const lblPage = contentEl.createEl('label', { text: 'Numero di Pagina a cui saltare:' });
    lblPage.style.display = 'block';
    const pageInp = contentEl.createEl('input', { type: 'number', value: '1' });
    pageInp.style.width = '100px';
    pageInp.style.marginBottom = '16px';

    const btnWrap = contentEl.createDiv({ cls: 'modal-button-container' });
    const btnCancel = btnWrap.createEl('button', { text: 'Annulla' });
    btnCancel.onclick = () => this.close();

    const btnSubmit = btnWrap.createEl('button', { text: 'Collega PDF', cls: 'mod-cta' });
    btnSubmit.onclick = () => {
      const p = inp.value.trim();
      const page = parseInt(pageInp.value, 10) || 1;
      if (!p) {
        new Notice('Specifica il nome del file PDF!');
        return;
      }
      this.onInsert(p, page);
      this.close();
    };

    setTimeout(() => inp.focus(), 50);
  }
}

class NodeLinkModal extends Modal {
  constructor(app, node, onInsert) {
    super(app);
    this.node = node;
    this.onInsert = onInsert;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '🔗 Inserisci Collegamento Esterno o Web' });

    const lblUrl = contentEl.createEl('label', { text: 'Indirizzo Web (URL):' });
    lblUrl.style.display = 'block';
    lblUrl.style.marginTop = '12px';
    const inpUrl = contentEl.createEl('input', { type: 'text', placeholder: 'https://example.com' });
    inpUrl.style.width = '100%';
    inpUrl.style.marginBottom = '12px';

    const lblText = contentEl.createEl('label', { text: 'Etichetta / Testo del Link:' });
    lblText.style.display = 'block';
    const inpText = contentEl.createEl('input', { type: 'text', placeholder: 'Sito Web / Riferimento' });
    inpText.style.width = '100%';
    inpText.style.marginBottom = '16px';

    const btnWrap = contentEl.createDiv({ cls: 'modal-button-container' });
    const btnCancel = btnWrap.createEl('button', { text: 'Annulla' });
    btnCancel.onclick = () => this.close();

    const btnSubmit = btnWrap.createEl('button', { text: 'Inserisci Link', cls: 'mod-cta' });
    btnSubmit.onclick = () => {
      const url = inpUrl.value.trim();
      const label = inpText.value.trim() || 'Link';
      if (!url) {
        new Notice('Inserisci un URL valido!');
        return;
      }
      this.onInsert(url, label);
      this.close();
    };

    setTimeout(() => inpUrl.focus(), 50);
  }
}

class MindmapExportModal extends Modal {
  constructor(app, canvas) {
    super(app);
    this.canvas = canvas;
    this.format = 'png';
    this.paperSize = 'A3';
    this.orientation = 'landscape';
    this.bgStyle = 'dark';
    this.qualityDpi = 2;
    this.includeTitleBlock = true;
    this.authorName = 'CDS Studio Architettura';
    this.headerText = 'CDS ARCHITETTURA & DESIGN · MAPPA CONCETTUALE';
    this.stampLogo = '📐 TIMBRO CDS';
    this.cartiglioWidth = 320;
    this.cartiglioHeight = 80;
    this.includeStamp = true;
    this.stampWidth = 65;
    this.stampHeight = 65;
    this.includeSignature = true;
    this.signatureWidth = 110;
    this.signatureHeight = 45;
    this.signatureText = 'Firma: Arch. Vorfreude';
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    if (modalEl) {
      modalEl.addClass('cds-mm-export-modal-window');
      modalEl.style.width = '94vw';
      modalEl.style.maxWidth = '1350px';
      modalEl.style.height = '90vh';
      modalEl.style.maxHeight = '940px';
      modalEl.style.display = 'flex';
      modalEl.style.flexDirection = 'column';
      modalEl.style.overflow = 'hidden';
    }
    contentEl.empty();
    contentEl.addClass('cds-mm-export-modal');

    contentEl.createEl('h2', { text: '🎨 Esportazione Professionale Mappa Concettuale (A0 - A6 & Vettoriale)', cls: 'cds-mm-export-title' });

    const layoutWrap = contentEl.createDiv({ cls: 'cds-mm-export-layout' });

    // Colonna Sinistra Comandi (Ampia e Chiara)
    const sidebar = layoutWrap.createDiv({ cls: 'cds-mm-export-sidebar' });

    sidebar.createEl('label', { text: 'Formato File:', cls: 'cds-mm-export-label' });
    const fmtSelect = sidebar.createEl('select', { cls: 'cds-mm-export-select' });
    [
      { val: 'png', label: 'PNG (Raster HD ad alta definizione)' },
      { val: 'svg', label: 'SVG (Vettoriale Completo 100% per CAD/Illustrator)' },
      { val: 'pdf', label: 'PDF (Stampa Tipografica 1:1)' },
      { val: 'jpg', label: 'JPG (Compresso Alta Qualità)' }
    ].forEach(f => {
      const opt = fmtSelect.createEl('option', { value: f.val, text: f.label });
      if (f.val === this.format) opt.selected = true;
    });
    fmtSelect.onchange = () => {
      this.format = fmtSelect.value;
      this.updatePreview();
    };

    sidebar.createEl('label', { text: 'Formato Carta Standard (ISO 216):', cls: 'cds-mm-export-label' });
    const paperSelect = sidebar.createEl('select', { cls: 'cds-mm-export-select' });
    Object.keys(PAPER_SIZES).forEach(k => {
      const opt = paperSelect.createEl('option', { value: k, text: PAPER_SIZES[k].label });
      if (k === this.paperSize) opt.selected = true;
    });
    paperSelect.onchange = () => {
      this.paperSize = paperSelect.value;
      this.updatePreview();
    };

    sidebar.createEl('label', { text: 'Orientamento Pagina:', cls: 'cds-mm-export-label' });
    const orientSelect = sidebar.createEl('select', { cls: 'cds-mm-export-select' });
    orientSelect.createEl('option', { value: 'landscape', text: '📐 Orizzontale (Landscape - Larghezza > Altezza)' });
    orientSelect.createEl('option', { value: 'portrait', text: '📏 Verticale (Portrait - Altezza > Larghezza)' });
    orientSelect.value = this.orientation;
    orientSelect.onchange = () => {
      this.orientation = orientSelect.value;
      this.updatePreview();
    };

    sidebar.createEl('label', { text: 'Colore Sfondo:', cls: 'cds-mm-export-label' });
    const bgSelect = sidebar.createEl('select', { cls: 'cds-mm-export-select' });
    bgSelect.createEl('option', { value: 'dark', text: 'Scuro Grafite (#0d1117)' });
    bgSelect.createEl('option', { value: 'light', text: 'Chiaro Carta (#ffffff)' });
    bgSelect.createEl('option', { value: 'transparent', text: 'Trasparente (PNG / SVG)' });
    bgSelect.value = this.bgStyle;
    bgSelect.onchange = () => {
      this.bgStyle = bgSelect.value;
      this.updatePreview();
    };

    // Cartiglio e Intestazione
    const blockBox = sidebar.createDiv({ cls: 'cds-mm-export-cartiglio-box' });
    const blockCb = blockBox.createEl('input', { type: 'checkbox', attr: { id: 'cds-cb-cart' } });
    blockCb.checked = this.includeTitleBlock;
    const blockLbl = blockBox.createEl('label', { text: ' Includi Cartiglio / Timbro Professionale e Intestazione', attr: { for: 'cds-cb-cart' } });
    blockCb.onchange = () => {
      this.includeTitleBlock = blockCb.checked;
      this.updatePreview();
    };

    const multiBox = sidebar.createDiv({ cls: 'cds-mm-export-cartiglio-box', attr: { style: 'margin-top:6px;border-top:1px solid rgba(255,255,255,0.08);padding-top:6px;' } });
    const multiCb = multiBox.createEl('input', { type: 'checkbox', attr: { id: 'cds-cb-multi' } });
    multiCb.checked = !!this.isMultipageFascicolo;
    const multiLbl = multiBox.createEl('label', { text: ' 📑 Fascicolo Tecnico Multipagina (Panoramica + Tavole Capitoli Singoli)', attr: { for: 'cds-cb-multi' } });
    multiCb.onchange = () => {
      this.isMultipageFascicolo = multiCb.checked;
    };

    sidebar.createEl('label', { text: 'Intestazione Mappa (Header Top):', cls: 'cds-mm-export-label' });
    const headerInp = sidebar.createEl('input', { cls: 'cds-mm-export-input', value: this.headerText });
    headerInp.oninput = () => {
      this.headerText = headerInp.value.trim();
      this.updatePreview();
    };

    sidebar.createEl('label', { text: 'Logo / Simbolo Cartiglio:', cls: 'cds-mm-export-label' });
    const logoInp = sidebar.createEl('input', { cls: 'cds-mm-export-input', value: this.stampLogo });
    logoInp.oninput = () => {
      this.stampLogo = logoInp.value.trim() || '📐 TIMBRO CDS';
      this.updatePreview();
    };

    sidebar.createEl('label', { text: 'Firma / Autore Progetto:', cls: 'cds-mm-export-label' });
    const authorInp = sidebar.createEl('input', { cls: 'cds-mm-export-input', value: this.authorName });
    authorInp.oninput = () => {
      this.authorName = authorInp.value.trim() || 'CDS Studio';
      this.updatePreview();
    };

    const bDownload = sidebar.createEl('button', { cls: 'cds-mm-btn-primary', text: '💾 Esporta e Scarica' });
    bDownload.onclick = () => this.doExport();

    // Colonna Destra Anteprima Ampia
    this.previewBox = layoutWrap.createDiv({ cls: 'cds-mm-export-preview-box' });
    this.previewCanvas = this.previewBox.createEl('canvas', { cls: 'cds-mm-export-canvas-preview' });

    this.updatePreview();
  }

  calculateGeometry() {
    const nodes = this.canvas.renderedNodes || [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.width > maxX) maxX = n.x + n.width;
      if (n.y + n.height > maxY) maxY = n.y + n.height;
    }

    const padding = 80;
    const contentW = (maxX - minX) + padding * 2;
    const contentH = (maxY - minY) + padding * 2;

    if (this.paperSize === 'Auto' || !PAPER_SIZES[this.paperSize]) {
      return { targetW: contentW, targetH: contentH, minX, minY, maxX, maxY, contentW, contentH };
    }

    const p = PAPER_SIZES[this.paperSize];
    const baseMin = Math.min(p.w, p.h);
    const baseMax = Math.max(p.w, p.h);

    // Landscape: Width is larger; Portrait: Height is larger
    const isLandscape = this.orientation === 'landscape';
    const sheetW = isLandscape ? baseMax : baseMin;
    const sheetH = isLandscape ? baseMin : baseMax;
    const sheetRatio = sheetW / sheetH;

    let targetW, targetH;
    if (contentW / contentH > sheetRatio) {
      targetW = contentW;
      targetH = contentW / sheetRatio;
    } else {
      targetH = contentH;
      targetW = contentH * sheetRatio;
    }

    return { targetW, targetH, minX, minY, maxX, maxY, contentW, contentH, sheetW, sheetH, isLandscape };
  }

  updatePreview() {
    const geo = this.calculateGeometry();
    const pCanvas = this.previewCanvas;
    const boxW = (this.previewBox && this.previewBox.clientWidth) ? Math.max(360, this.previewBox.clientWidth - 40) : 660;
    const boxH = (this.previewBox && this.previewBox.clientHeight) ? Math.max(300, this.previewBox.clientHeight - 40) : 560;
    const scaleW = boxW / geo.targetW;
    const scaleH = boxH / geo.targetH;
    const scale = Math.min(scaleW, scaleH);

    pCanvas.width = Math.round(geo.targetW * scale);
    pCanvas.height = Math.round(geo.targetH * scale);

    const ctx = pCanvas.getContext('2d');
    ctx.clearRect(0, 0, pCanvas.width, pCanvas.height);

    if (this.bgStyle === 'light') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pCanvas.width, pCanvas.height);
    } else if (this.bgStyle === 'dark') {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, pCanvas.width, pCanvas.height);
    }

    // Bordo del foglio
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, pCanvas.width - 4, pCanvas.height - 4);

    const offsetX = (geo.targetW - geo.contentW) / 2 + 80 - geo.minX;
    const offsetY = (geo.targetH - geo.contentH) / 2 + 80 - geo.minY;

    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(offsetX, offsetY);

    // Curve di connessione
    for (const p of this.canvas.renderedPaths || []) {
      ctx.strokeStyle = p.color || '#38bdf8';
      ctx.lineWidth = 2.6;
      const path2d = new Path2D(p.d);
      ctx.stroke(path2d);
    }

    // Nodi
    for (const n of this.canvas.renderedNodes || []) {
      ctx.fillStyle = n.isRoot ? '#2563eb' : (this.bgStyle === 'light' ? '#f1f5f9' : '#1e293b');
      ctx.strokeStyle = n.color || '#38bdf8';
      ctx.lineWidth = 1.8;

      ctx.beginPath();
      ctx.roundRect(n.x, n.y, n.width, n.height, 8);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = (this.bgStyle === 'light' && !n.isRoot) ? '#0f172a' : '#ffffff';
      ctx.font = n.isRoot ? 'bold 16px sans-serif' : '13px sans-serif';
      ctx.fillText(n.text.slice(0, 30), n.x + 10, n.y + (n.height / 2) + 5);
    }

    ctx.restore();

    // Cartiglio / Timbro nell'angolo inferiore destro
    if (this.includeTitleBlock) {
      this.drawTitleBlockOnCanvas(ctx, pCanvas.width, pCanvas.height, scale);
    }
  }

  drawTitleBlockOnCanvas(ctx, w, h, scale) {
    const s = scale || 1;
    if (this.headerText) {
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold ' + Math.max(9, Math.round(11 * s)) + 'px sans-serif';
      ctx.fillText(this.headerText.slice(0, 60), 16 * s, 22 * s);
    }

    if (!this.includeTitleBlock) return;

    const boxW = Math.round(this.cartiglioWidth * s);
    const boxH = Math.round(this.cartiglioHeight * s);
    const boxX = w - boxW - (12 * s);
    const boxY = h - boxH - (12 * s);

    ctx.fillStyle = this.bgStyle === 'light' ? 'rgba(241, 245, 249, 0.96)' : 'rgba(22, 27, 46, 0.96)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = Math.max(1, 1.8 * s);

    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    const pad = 10 * s;
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold ' + Math.max(8, Math.round(11 * s)) + 'px sans-serif';
    ctx.fillText(this.stampLogo.slice(0, 30), boxX + pad, boxY + (16 * s));

    ctx.fillStyle = this.bgStyle === 'light' ? '#0f172a' : '#f8fafc';
    ctx.font = 'bold ' + Math.max(8, Math.round(10 * s)) + 'px sans-serif';
    const noteTitle = (this.canvas.rawRootNode.text || 'Mappa').slice(0, 32);
    ctx.fillText(noteTitle, boxX + pad, boxY + (32 * s));

    ctx.fillStyle = '#94a3b8';
    ctx.font = Math.max(7, Math.round(9 * s)) + 'px sans-serif';
    const dateStr = new Date().toISOString().slice(0, 10);
    ctx.fillText(this.paperSize + ' ' + this.orientation + ' · ' + dateStr + ' · ' + this.authorName.slice(0, 20), boxX + pad, boxY + (48 * s));

    if (this.includeStamp) {
      const sW = Math.round(this.stampWidth * s);
      const sH = Math.round(this.stampHeight * s);
      const stampX = boxX - sW - (10 * s);
      const stampY = h - sH - (12 * s);

      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = Math.max(1, 1.5 * s);
      ctx.strokeRect(stampX, stampY, sW, sH);

      ctx.fillStyle = '#f43f5e';
      ctx.font = 'bold ' + Math.max(6, Math.round(8 * s)) + 'px sans-serif';
      ctx.fillText('TIMBRO CDS', stampX + (4 * s), stampY + (14 * s));
      ctx.fillText('ORDINE ARCHITETTI', stampX + (4 * s), stampY + (26 * s));
      ctx.fillText('VALIDATO', stampX + (4 * s), stampY + (40 * s));
    }

    if (this.includeSignature) {
      const sigW = Math.round(this.signatureWidth * s);
      const sigH = Math.round(this.signatureHeight * s);
      const sigX = boxX + boxW - sigW - (8 * s);
      const sigY = boxY + boxH - sigH - (4 * s);

      ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
      ctx.beginPath();
      ctx.moveTo(sigX, sigY + sigH - 2);
      ctx.lineTo(sigX + sigW, sigY + sigH - 2);
      ctx.stroke();

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'italic ' + Math.max(7, Math.round(9 * s)) + 'px sans-serif';
      ctx.fillText(this.signatureText.slice(0, 22), sigX + (4 * s), sigY + sigH - (6 * s));
    }
  }

  doExport() {
    const title = (this.canvas.rawRootNode.text || 'mindmap').replace(/[/\\?%*:|"<>]/g, '_');
    const ext = this.format;
    const fileName = `${title}_${this.paperSize}_${this.orientation}.${ext}`;
    const geo = this.calculateGeometry();

    // 1. ESPORTAZIONE VETTORIALE SVG COMPLETA
    if (this.format === 'svg') {
      const svgContent = this.generateCompleteVectorSVG(geo);
      const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      new Notice(`✅ Esportazione vettoriale completata: ${fileName}`);
      this.close();
      return;
    }

    // 2. ESPORTAZIONE RASTER HD (PNG, JPG, PDF)
    const exportCanvas = document.createElement('canvas');
    const dpi = this.qualityDpi;
    exportCanvas.width = Math.round(geo.targetW * dpi);
    exportCanvas.height = Math.round(geo.targetH * dpi);

    const ctx = exportCanvas.getContext('2d');
    ctx.scale(dpi, dpi);

    if (this.bgStyle === 'light') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, geo.targetW, geo.targetH);
    } else if (this.bgStyle === 'dark') {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, geo.targetW, geo.targetH);
    }

    const offsetX = (geo.targetW - geo.contentW) / 2 + 80 - geo.minX;
    const offsetY = (geo.targetH - geo.contentH) / 2 + 80 - geo.minY;

    ctx.save();
    ctx.translate(offsetX, offsetY);

    for (const p of this.canvas.renderedPaths || []) {
      ctx.strokeStyle = p.color || '#38bdf8';
      ctx.lineWidth = 2.8;
      const path2d = new Path2D(p.d);
      ctx.stroke(path2d);
    }

    for (const n of this.canvas.renderedNodes || []) {
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

    if (this.includeTitleBlock) {
      // Cartiglio su scala esportazione
      const boxW = 340;
      const boxH = 90;
      const boxX = geo.targetW - boxW - 24;
      const boxY = geo.targetH - boxH - 24;

      ctx.fillStyle = this.bgStyle === 'light' ? '#f8fafc' : '#161b2e';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.strokeRect(boxX, boxY, boxW, boxH);

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText('📐 CDS STUDIO ARCHITETTURA', boxX + 14, boxY + 22);

      ctx.fillStyle = this.bgStyle === 'light' ? '#0f172a' : '#ffffff';
      ctx.font = '13px sans-serif';
      ctx.fillText(this.canvas.rawRootNode.text || 'Mappa Concettuale', boxX + 14, boxY + 44);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px sans-serif';
      ctx.fillText(`Formato: ${this.paperSize} ${this.orientation} · ${new Date().toISOString().slice(0, 10)} · ${this.authorName}`, boxX + 14, boxY + 68);
    }

    if (this.format === 'pdf') {
      const dataUrl = exportCanvas.toDataURL('image/jpeg', 0.95);
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        let pagesHtml = `<div class="print-page"><img src="${dataUrl}" /></div>`;

        if (this.isMultipageFascicolo && this.canvas.rawRootNode && this.canvas.rawRootNode.children) {
          const chapters = this.canvas.rawRootNode.children;
          chapters.forEach((chap, cIdx) => {
            const chapCanvas = document.createElement('canvas');
            chapCanvas.width = exportCanvas.width;
            chapCanvas.height = exportCanvas.height;
            const cCtx = chapCanvas.getContext('2d');

            cCtx.fillStyle = this.bgStyle === 'light' ? '#ffffff' : '#0d1117';
            cCtx.fillRect(0, 0, chapCanvas.width, chapCanvas.height);

            cCtx.fillStyle = '#38bdf8';
            cCtx.font = 'bold 22px sans-serif';
            cCtx.fillText('TAVOLA ' + (cIdx + 2) + ': ' + (chap.text || '').toUpperCase(), 40, 50);

            cCtx.save();
            cCtx.globalAlpha = 0.25;
            cCtx.drawImage(exportCanvas, 0, 0);
            cCtx.restore();

            const chapNode = (this.canvas.renderedNodes || []).find(n => n.id === chap.id);
            if (chapNode) {
              const offsetX = (geo.targetW - geo.contentW) / 2 + 80 - geo.minX;
              const offsetY = (geo.targetH - geo.contentH) / 2 + 80 - geo.minY;
              cCtx.save();
              cCtx.translate(offsetX, offsetY);
              cCtx.strokeStyle = '#fbbf24';
              cCtx.lineWidth = 3;
              cCtx.strokeRect(chapNode.x - 12, chapNode.y - 12, chapNode.width + 24, chapNode.height + 24);
              cCtx.restore();
            }

            const chapDataUrl = chapCanvas.toDataURL('image/jpeg', 0.95);
            pagesHtml += `<div class="print-page" style="page-break-before: always;"><img src="${chapDataUrl}" /></div>`;
          });
        }

        printWindow.document.write(`
          <html>
            <head>
              <title>${title} - Fascicolo Tecnico CDS</title>
              <style>
                @page { size: ${this.paperSize === 'Auto' ? 'auto' : this.paperSize} ${this.orientation}; margin: 0; }
                body { margin: 0; background: ${this.bgStyle === 'light' ? '#ffffff' : '#0d1117'}; }
                .print-page { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; page-break-after: always; }
                img { width: 100vw; height: 100vh; object-fit: contain; }
              </style>
            </head>
            <body>
              ${pagesHtml}
              <script>window.onload = () => window.print();</script>
            </body>
          </html>
        `);
        printWindow.document.close();
      }
      new Notice(`📄 Fascicolo di stampa PDF ${this.paperSize} pronto!`);
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

  generateCompleteVectorSVG(geo) {
    const bg = this.bgStyle === 'light' ? '#ffffff' : (this.bgStyle === 'transparent' ? 'none' : '#0d1117');
    const textFill = this.bgStyle === 'light' ? '#0f172a' : '#ffffff';
    const offsetX = (geo.targetW - geo.contentW) / 2 + 80 - geo.minX;
    const offsetY = (geo.targetH - geo.contentH) / 2 + 80 - geo.minY;

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(geo.targetW)}" height="${Math.round(geo.targetH)}" viewBox="0 0 ${Math.round(geo.targetW)} ${Math.round(geo.targetH)}">
<defs>
  <style>
    .node-text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; fill: ${textFill}; }
    .root-text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 18px; font-weight: bold; fill: #ffffff; }
    .branch-line { fill: none; stroke-linecap: round; stroke-width: 2.8px; }
  </style>
</defs>
`;

    if (bg !== 'none') {
      svg += `<rect width="100%" height="100%" fill="${bg}"/>\n`;
    }

    svg += `<g transform="translate(${offsetX}, ${offsetY})">\n`;

    // Branch paths & edge labels
    for (const p of this.canvas.renderedPaths || []) {
      svg += `  <path d="${p.d}" stroke="${p.color || '#38bdf8'}" class="branch-line"/>\n`;
      if (p.edgeText) {
        const coords = p.d.match(/[-+]?[0-9]*\.?[0-9]+/g);
        if (coords && coords.length >= 8) {
          const x0 = parseFloat(coords[0]), y0 = parseFloat(coords[1]);
          const x1 = parseFloat(coords[2]), y1 = parseFloat(coords[3]);
          const x2 = parseFloat(coords[4]), y2 = parseFloat(coords[5]);
          const x3 = parseFloat(coords[6]), y3 = parseFloat(coords[7]);
          const midX = 0.125 * x0 + 0.375 * x1 + 0.375 * x2 + 0.125 * x3;
          const midY = 0.125 * y0 + 0.375 * y1 + 0.375 * y2 + 0.125 * y3;
          const textW = Math.max(36, p.edgeText.length * 7.5 + 14);
          const cleanEdgeText = p.edgeText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          svg += `  <g class="edge-label">
    <rect x="${midX - (textW / 2)}" y="${midY - 10}" width="${textW}" height="18" rx="4" fill="#1e293b" stroke="${p.color || '#38bdf8'}" stroke-width="1"/>
    <text x="${midX}" y="${midY + 4}" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="bold" fill="#38bdf8">${cleanEdgeText}</text>
  </g>\n`;
        }
      }
    }

    // Nodes
    for (const n of this.canvas.renderedNodes || []) {
      const fill = n.isRoot ? '#2563eb' : (this.bgStyle === 'light' ? '#f8fafc' : '#1a2238');
      const stroke = n.color || '#38bdf8';
      const cleanText = (n.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      svg += `  <g class="node-group">
    <rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
    <text x="${n.x + 14}" y="${n.y + (n.height / 2) + 5}" class="${n.isRoot ? 'root-text' : 'node-text'}">${cleanText}</text>
  </g>\n`;
    }

    svg += `</g>\n`;

    // Intestazione Superiore Vettoriale
    if (this.includeTitleBlock && this.headerText) {
      const cleanHeader = this.headerText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      svg += `  <text x="30" y="40" font-family="sans-serif" font-size="16" font-weight="bold" fill="#38bdf8">${cleanHeader}</text>\n`;
    }

    // Cartiglio vettoriale
    if (this.includeTitleBlock) {
      const boxW = 360;
      const boxH = 96;
      const boxX = geo.targetW - boxW - 24;
      const boxY = geo.targetH - boxH - 24;
      const cFill = this.bgStyle === 'light' ? '#f1f5f9' : '#161b2e';
      const cleanLogo = this.stampLogo.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const cleanTitle = (this.canvas.rawRootNode.text || 'Mappa').slice(0, 36).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      svg += `<g class="cartiglio" transform="translate(${boxX}, ${boxY})">
  <rect width="${boxW}" height="${boxH}" rx="8" fill="${cFill}" stroke="#38bdf8" stroke-width="2"/>
  <text x="16" y="26" font-family="sans-serif" font-size="14" font-weight="bold" fill="#38bdf8">${cleanLogo}</text>
  <text x="16" y="52" font-family="sans-serif" font-size="13" font-weight="600" fill="${textFill}">${cleanTitle}</text>
  <text x="16" y="76" font-family="sans-serif" font-size="11" fill="#94a3b8">Formato: ${this.paperSize} ${this.orientation} · ${new Date().toISOString().slice(0, 10)} · ${this.authorName}</text>
</g>\n`;
    }

    svg += `</svg>`;
    return svg;
  }
}

// ==========================================================================
// 3. MindmapCanvas: Controller con Foglio di Stampa su Canvas e Toolbar
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

    // v1.7.4: Stile connettori, ripasso attivo e breadcrumb glow
    this.connectorStyle = options.connectorStyle || 'curved';
    this.isStudyMode = false;
    this.revealedNodes = new Set();
    this.hoveredNodeId = null;

    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.isDraggingCanvas = false;
    this.dragStart = { x: 0, y: 0 };
    this.expandedNodes = new Set();
    this.showMinimap = true;

    // Anteprima Foglio di Stampa direttamente sul Canvas
    this.showSheetOverlay = false;
    this.sheetFormat = 'A3';
    this.sheetOrientation = 'landscape';

    // RIPRISTINA MEMORIA LAYOUT SALVATA SU DISCO (DATA.JSON) PER QUESTO FILE
    if (this.plugin && this.plugin.settings && this.plugin.settings.fileLayouts && this.filePath) {
      const saved = this.plugin.settings.fileLayouts[this.filePath];
      if (saved) {
        if (saved.viewMode) this.viewMode = saved.viewMode;
        if (saved.detailLevel) this.detailLevel = saved.detailLevel;
        if (saved.connectorStyle) this.connectorStyle = saved.connectorStyle;
        if (saved.isOrganicView !== undefined) this.isOrganicView = saved.isOrganicView;
        if (saved.panX !== undefined) this.panX = saved.panX;
        if (saved.panY !== undefined) this.panY = saved.panY;
        if (saved.zoom !== undefined) this.zoom = saved.zoom;

        if (saved.positions) {
          for (const [id, pos] of Object.entries(saved.positions)) {
            const raw = this.findRawNode(id);
            if (raw) {
              if (pos.x !== undefined) raw.customX = pos.x;
              if (pos.y !== undefined) raw.customY = pos.y;
              if (pos.customWidth) raw.customWidth = pos.customWidth;
              if (pos.customHeight) raw.customHeight = pos.customHeight;
              if (pos.layout) raw.layout = pos.layout;
              if (pos.isOrganic !== undefined) raw.isOrganic = pos.isOrganic;
              if (pos.edgeText) raw.edgeText = pos.edgeText;
              if (pos.priority) raw.priority = pos.priority;
              if (pos.customColor) raw.customColor = pos.customColor;
            }
          }
        }
        if (Array.isArray(saved.collapsed)) {
          for (const id of saved.collapsed) {
            const raw = this.findRawNode(id);
            if (raw) raw.collapsed = true;
          }
        }
      }
    }

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

    // Overlay Foglio di Stampa nel Canvas
    this.sheetOverlayEl = this.stage.createDiv({ cls: 'cds-mm-sheet-overlay' });
    this.sheetOverlayEl.style.display = 'none';

    this.svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svgLayer.setAttribute('class', 'cds-mm-svg');
    this.stage.appendChild(this.svgLayer);

    this.nodesLayer = this.stage.createDiv({ cls: 'cds-mm-nodes-layer' });

    // Floating Bar contestuale sul nodo selezionato
    this.floatingBar = this.stage.createDiv({ cls: 'cds-mm-floating-bar' });
    this.floatingBar.style.display = 'none';

    // 3. MINIMAP RADAR
    this.minimapWrap = this.container.createDiv({ cls: 'cds-mm-minimap' });
    this.minimapCanvas = this.minimapWrap.createEl('canvas', { cls: 'cds-mm-minimap-canvas' });
    this.minimapCanvas.width = 170;
    this.minimapCanvas.height = 110;
    this.minimapLens = this.minimapWrap.createDiv({ cls: 'cds-mm-minimap-lens' });
    this.setupMinimapEvents();

    // 4. TABELLA E OUTLINE GLOBALI
    this.tableContainer = this.container.createDiv({ cls: 'cds-mm-table-container' });
    this.tableContainer.style.display = 'none';

    this.outlineContainer = this.container.createDiv({ cls: 'cds-mm-outline-container' });
    this.outlineContainer.style.display = 'none';

    // Eventi Canvas
    this.viewport.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.viewport.addEventListener('dblclick', (e) => {
      if (e.target.closest('.cds-mm-node') || e.target.closest('.cds-mm-top-dock') || e.target.closest('.cds-mm-floating-bar') || e.target.closest('.cds-mm-minimap')) return;
      e.preventDefault();
      e.stopPropagation();

      const rect = this.viewport.getBoundingClientRect();
      const canvasX = Math.round((e.clientX - rect.left - this.panX) / this.zoom);
      const canvasY = Math.round((e.clientY - rect.top - this.panY) / this.zoom);

      this.createNodeAtCoordinates(canvasX, canvasY);
    });

    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Scroll orizzontale dock con rotellina del mouse
    this.topDock.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) {
        this.topDock.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });

    // Tastiera
    this.container.setAttribute('tabindex', '0');
    this.container.addEventListener('keydown', (e) => this.onKeyDown(e));

    // ResizeObserver per responsività dinamica dock superiore
    if (typeof ResizeObserver !== 'undefined') {
      this.dockResizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = entry.contentRect.width;
          if (w < 1180) {
            this.topDock.classList.add('is-narrow');
          } else {
            this.topDock.classList.remove('is-narrow');
          }
          if (w < 880) {
            this.topDock.classList.add('is-compact');
          } else {
            this.topDock.classList.remove('is-compact');
          }
        }
      });
      this.dockResizeObserver.observe(this.container);
    }
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
        this.saveLayoutMemory();
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

    const btnOrganic = groupViews.createEl('button', {
      cls: 'cds-mm-dock-btn' + (this.isOrganicView ? ' is-active' : ''),
      attr: { title: 'Alterna Stile Caselle e Vista Organica (senza box)' }
    });
    btnOrganic.innerHTML = `🌿 <span class="cds-mm-btn-text">${this.isOrganicView ? 'Organica' : 'Caselle'}</span>`;
    btnOrganic.onmousedown = (e) => e.stopPropagation();
    btnOrganic.onclick = (e) => {
      e.stopPropagation();
      this.isOrganicView = !this.isOrganicView;
      btnOrganic.innerHTML = `🌿 <span class="cds-mm-btn-text">${this.isOrganicView ? 'Organica' : 'Caselle'}</span>`;
      btnOrganic.classList.toggle('is-active', this.isOrganicView);
      this.saveLayoutMemory();
      this.render();
    };

    const connectorIcons = { curved: '🌊 Curvi', orthogonal: '📐 Squadrati', straight: '📏 Lineari' };
    const btnConnector = groupViews.createEl('button', {
      cls: 'cds-mm-dock-btn',
      attr: { title: 'Cambia stile connettori: Curvi (Bezier), Ortogonali (CAD 90°) o Lineari' }
    });
    btnConnector.innerHTML = connectorIcons[this.connectorStyle] || '🌊 Curvi';
    btnConnector.onmousedown = (e) => e.stopPropagation();
    btnConnector.onclick = (e) => {
      e.stopPropagation();
      const styles = ['curved', 'orthogonal', 'straight'];
      const nextIdx = (styles.indexOf(this.connectorStyle) + 1) % styles.length;
      this.connectorStyle = styles[nextIdx];
      btnConnector.innerHTML = connectorIcons[this.connectorStyle];
      this.render();
      this.saveLayoutMemory();
      new Notice('📐 Stile connettori: ' + this.connectorStyle.toUpperCase());
    };

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
        this.saveLayoutMemory();
        this.renderTopDock();
        this.render();
      };
      return b;
    };

    mkDetailBtn('titles', 'Titoli', '🏷️', 'Mostra solo la gerarchia H1..H6');
    mkDetailBtn('keypoints', 'Punti Chiave', '🎯', 'Mostra titoli e concetti chiave');
    mkDetailBtn('full', 'Tutto', '📖', 'Mostra testo completo dei paragrafi');

    // GRUPPO 3: STRUMENTI & OPERAZIONI
    const groupTools = this.topDock.createDiv({ cls: 'cds-mm-dock-group' });

    const mkToolBtn = (icon, tip, onClick, isActive = false) => {
      const b = groupTools.createEl('button', {
        cls: 'cds-mm-dock-btn' + (isActive ? ' is-active' : ''),
        attr: { title: tip }
      });
      b.innerHTML = icon;
      b.onmousedown = (e) => e.stopPropagation();
      b.onclick = (e) => { e.stopPropagation(); onClick(); };
      return b;
    };

    mkToolBtn('➕ <span class="cds-mm-btn-text">Figlio</span>', 'Aggiungi Nodo Figlio (Tab)', () => this.addChildToSelected());
    mkToolBtn('⏬ <span class="cds-mm-btn-text">Fratello</span>', 'Aggiungi Nodo Fratello (Enter)', () => this.addSiblingToSelected());
    mkToolBtn('🗑️', 'Elimina Nodo (Canc)', () => this.deleteSelected());

    // Modalità Ripasso Orale (Flashcard Interactive)
    const btnStudy = groupTools.createEl('button', {
      cls: 'cds-mm-dock-btn' + (this.isStudyMode ? ' is-active' : ''),
      attr: { title: 'Modalità Ripasso Orale: copre i concetti e permette di verificarli uno ad uno' }
    });
    btnStudy.innerHTML = '🎓 <span class="cds-mm-btn-text">Ripasso</span>';
    btnStudy.onmousedown = (e) => e.stopPropagation();
    btnStudy.onclick = (e) => {
      e.stopPropagation();
      this.toggleStudyMode();
    };

    if (this.isStudyMode) {
      const btnRecover = groupTools.createEl('button', {
        cls: 'cds-mm-dock-btn',
        attr: { title: 'Ricopre tutti i concetti per iniziare un nuovo ciclo di ripasso' }
      });
      btnRecover.innerHTML = '🔄 <span class="cds-mm-btn-text">Ricopri Tutto</span>';
      btnRecover.onmousedown = (e) => e.stopPropagation();
      btnRecover.onclick = (e) => {
        e.stopPropagation();
        this.revealedNodes.clear();
        this.render();
        new Notice('🔄 Tutti i concetti sono stati ricoperti!');
      };
    }

    groupTools.createDiv({ cls: 'cds-mm-divider' });

    mkToolBtn('🔍 Adatta', 'Visualizza Intera Mappa nello Schermo (Fit-All)', () => this.fitToScreen());
    mkToolBtn('🧭 Centra', 'Centra la radice della mappa (Ctrl+E)', () => this.centerRoot());
    mkToolBtn('🔄 <span class="cds-mm-btn-text">Resetta Mappa</span>', 'Cancella la memoria della mappa e ripristina la geometria automatica anti-sovrapposizione', () => this.resetLayoutMemory());

    // Toggle Foglio di Stampa su Canvas
    mkToolBtn('📄 <span class="cds-mm-btn-text">Foglio Stampa</span>', 'Mostra / Nascondi perimetro foglio A0-A6 sul canvas', () => this.toggleSheetOverlay(), this.showSheetOverlay);
    mkToolBtn('🗺️', 'Attiva/Disattiva Minimap', () => this.toggleMinimap());

    groupTools.createDiv({ cls: 'cds-mm-divider' });

    mkToolBtn('📤 Esporta HD', 'Esporta nei formati da A0 ad A6 (PNG, JPG, PDF, SVG Vettoriale)', () => this.openExportModal());

    // Ricerca Rapida Concetti nella Mappa
    const searchWrap = groupTools.createDiv({ cls: 'cds-mm-search-wrap' });
    searchWrap.style.cssText = 'display:flex;align-items:center;margin-left:6px;';
    const inpSearch = searchWrap.createEl('input', {
      type: 'text',
      placeholder: '🔍 Cerca nodo...',
      cls: 'cds-mm-dock-search'
    });
    inpSearch.style.cssText = 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:14px;padding:3px 10px;font-size:0.75rem;color:#f8fafc;width:110px;outline:none;transition:all 0.2s ease;';
    inpSearch.onfocus = () => { inpSearch.style.width = '170px'; inpSearch.style.borderColor = '#38bdf8'; };
    inpSearch.onblur = () => { if (!inpSearch.value) { inpSearch.style.width = '110px'; inpSearch.style.borderColor = 'rgba(255,255,255,0.15)'; } };
    inpSearch.onmousedown = (e) => e.stopPropagation();
    inpSearch.oninput = () => {
      const q = inpSearch.value.trim().toLowerCase();
      const allEls = this.nodesLayer.querySelectorAll('.cds-mm-node');
      allEls.forEach(el => {
        if (!q) {
          el.style.opacity = '1';
          el.style.boxShadow = '';
        } else if (el.textContent.toLowerCase().includes(q)) {
          el.style.opacity = '1';
          el.style.boxShadow = '0 0 16px rgba(251, 191, 36, 0.8), 0 0 0 2px #fbbf24';
        } else {
          el.style.opacity = '0.22';
          el.style.boxShadow = '';
        }
      });
    };
  }

  toggleSheetOverlay() {
    this.showSheetOverlay = !this.showSheetOverlay;
    this.renderTopDock();
    this.render();
    if (this.showSheetOverlay) {
      new Notice(`📄 Riquadro foglio di stampa attivo (${this.sheetFormat} ${this.sheetOrientation})`);
    }
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
    const layoutOpts = { detailLevel: this.detailLevel, connectorStyle: this.connectorStyle };
    if (this.viewMode === 'radial') {
      layout = MindmapEngine.computeRadialLayout(activeTree, layoutOpts);
    } else if (this.viewMode === 'bilateral') {
      layout = MindmapEngine.computeBilateralLayout(activeTree, layoutOpts);
    } else {
      layout = MindmapEngine.computeRightLayout(activeTree, layoutOpts);
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
      if (node.x + node.width > maxX) maxX = node.x + node.width + 220;
      if (node.y + node.height > maxY) maxY = node.y + node.height + 220;

      const isSelected = node.id === this.selectedNodeId;

      const nodeEl = this.nodesLayer.createDiv({
        cls: 'cds-mm-node' +
          (node.isRoot ? ' is-root' : ` level-${node.depth}`) +
          ((this.isOrganicView || node.isOrganic) ? ' is-organic' : '') +
          (node.type === 'keypoint' ? ' is-keypoint' : '') +
          (node.layout === 'table' ? ' is-table-node' : '') +
          (isSelected ? ' is-selected' : '') +
          (node.direction === 'left' ? ' is-left' : ' is-right')
      });

      nodeEl.setAttribute('data-node-id', node.id);
      nodeEl.style.left = `${node.x}px`;
      nodeEl.style.top = `${node.y}px`;
      nodeEl.style.width = `${node.width}px`;
      nodeEl.style.minHeight = `${node.height}px`;
      const finalBorderColor = node.customColor || (node.isRoot ? 'rgba(255,255,255,0.5)' : node.color || '#38bdf8');
      nodeEl.style.borderColor = finalBorderColor;
      if (node.customColor) {
        nodeEl.style.boxShadow = '0 0 14px ' + node.customColor + '44';
      }

      if (isSelected) selectedNodeEl = nodeEl;

      // Resize handle stile Canvas
      const resizeHandle = nodeEl.createDiv({ cls: 'cds-mm-resize-handle', attr: { title: 'Trascina per ridimensionare il nodo' } });
      resizeHandle.onmousedown = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        this.initNodeResize(node, nodeEl, ev);
      };

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

        if (node.priority === 'high') {
          headerRow.createSpan({ text: '🔴 DA RIVEDERE', cls: 'cds-mm-prio-badge prio-high' });
        } else if (node.priority === 'medium') {
          headerRow.createSpan({ text: '🟡 IN DUBBIO', cls: 'cds-mm-prio-badge prio-medium' });
        } else if (node.priority === 'done') {
          headerRow.createSpan({ text: '🟢 PRONTO', cls: 'cds-mm-prio-badge prio-done' });
        }

        const isMasked = this.isStudyMode && !node.isRoot && node.depth > 0 && !this.revealedNodes.has(node.id);
        if (isMasked) {
          nodeEl.classList.add('is-study-masked');
          const maskEl = nodeEl.createDiv({ cls: 'cds-mm-study-mask' });
          maskEl.innerHTML = '<span class="cds-mm-mask-icon">❓</span> <span class="cds-mm-mask-text">Svela Concetto (Spazio)</span>';
          maskEl.onmousedown = (e) => e.stopPropagation();
          maskEl.onclick = (e) => {
            e.stopPropagation();
            this.revealedNodes.add(node.id);
            this.render();
          };
        }

        const titleEl = headerRow.createDiv({ cls: 'cds-mm-node-title' });
        if (isMasked) {
          titleEl.style.display = 'none';
        } else {
          titleEl.innerHTML = MindmapEngine.renderMiniMarkdown(node.text);
        }

        if (this.isStudyMode && !node.isRoot && node.depth > 0 && this.revealedNodes.has(node.id)) {
          const revTag = headerRow.createSpan({ text: '✓ Svelato', cls: 'cds-mm-study-tag' });
          revTag.onmousedown = (e) => e.stopPropagation();
          revTag.onclick = (e) => {
            e.stopPropagation();
            this.revealedNodes.delete(node.id);
            this.render();
          };
        }

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

        if (node.pdfLink) {
          const badge = nodeEl.createDiv({ cls: 'cds-mm-pdf-badge' });
          badge.innerHTML = `📄 <b>${node.pdfLink.file}</b> · Pag. ${node.pdfLink.page}`;
          badge.onmousedown = (ev) => ev.stopPropagation();
          badge.onclick = (ev) => {
            ev.stopPropagation();
            if (this.options.onPdfJump) this.options.onPdfJump(node.pdfLink);
          };
        }

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
          };
        }
      }

      // Click delegation per wikilink, collegamenti esterni e note ipertestuali
      nodeEl.onclick = (ev) => {
        const wikiLink = ev.target.closest('.cds-mm-wikilink');
        if (wikiLink && (ev.ctrlKey || ev.metaKey)) {
          ev.stopPropagation();
          ev.preventDefault();
          const target = wikiLink.getAttribute('data-target');
          if (target && this.app) {
            this.app.workspace.openLinkText(target, this.filePath || '', true);
          }
          return;
        }

        const extLink = ev.target.closest('a.cds-mm-ext-link');
        if (extLink) {
          ev.stopPropagation();
          return; // Apre direttamente in browser con target="_blank"
        }

        const footnote = ev.target.closest('.cds-mm-footnote');
        if (footnote) {
          ev.stopPropagation();
          const fnId = footnote.getAttribute('data-footnote');
          if (this.options.onNodeClick) {
            this.options.onNodeClick({ ...node, text: `[^${fnId}]` });
          }
          return;
        }
      };

      nodeEl.onmousedown = (ev) => {
        if (((ev.ctrlKey || ev.metaKey) && ev.target.closest('.cds-mm-wikilink')) || ev.target.closest('a') || ev.target.closest('.cds-mm-pdf-badge') || ev.target.closest('.cds-mm-fold-btn') || ev.target.closest('.cds-mm-footnote')) {
          ev.stopPropagation();
          return;
        }

        ev.stopPropagation();
        this.selectNode(node.id);

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

    // Render Overlay Foglio Stampa sul Canvas se attivo
    this.renderCanvasSheetOverlay();

    this.updateFloatingBar(selectedNodeEl);
    this.updateTransform();
    this.updateMinimap();
  }

  renderCanvasSheetOverlay() {
    if (!this.showSheetOverlay) {
      this.sheetOverlayEl.style.display = 'none';
      return;
    }

    this.sheetOverlayEl.style.display = 'block';
    this.sheetOverlayEl.empty();

    // Calcolo dimensioni foglio
    const nodes = this.renderedNodes || [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.width > maxX) maxX = n.x + n.width;
      if (n.y + n.height > maxY) maxY = n.y + n.height;
    }

    const padding = 80;
    const contentW = (maxX - minX) + padding * 2;
    const contentH = (maxY - minY) + padding * 2;

    const p = PAPER_SIZES[this.sheetFormat] || PAPER_SIZES.A3;
    const baseMin = Math.min(p.w, p.h);
    const baseMax = Math.max(p.w, p.h);
    const isLandscape = this.sheetOrientation === 'landscape';
    const sheetW = isLandscape ? baseMax : baseMin;
    const sheetH = isLandscape ? baseMin : baseMax;
    const sheetRatio = sheetW / sheetH;

    let targetW, targetH;
    if (contentW / contentH > sheetRatio) {
      targetW = contentW;
      targetH = contentW / sheetRatio;
    } else {
      targetH = contentH;
      targetW = contentH * sheetRatio;
    }

    const sheetX = minX - padding - (targetW - contentW) / 2;
    const sheetY = minY - padding - (targetH - contentH) / 2;

    this.sheetOverlayEl.style.left = `${sheetX}px`;
    this.sheetOverlayEl.style.top = `${sheetY}px`;
    this.sheetOverlayEl.style.width = `${targetW}px`;
    this.sheetOverlayEl.style.height = `${targetH}px`;

    // Banner superiore con titolo
    const banner = this.sheetOverlayEl.createDiv({ cls: 'cds-mm-sheet-banner' });
    banner.innerHTML = `📄 <b>FOGLIO DI STAMPA: ${this.sheetFormat} ${isLandscape ? 'ORIZZONTALE' : 'VERTICALE'}</b> · Sposta i nodi liberamente per comporli nel foglio`;

    // Cartiglio nel foglio
    const titleBlock = this.sheetOverlayEl.createDiv({ cls: 'cds-mm-sheet-cartiglio' });
    titleBlock.innerHTML = `
      <div class="cds-mm-cart-title">📐 CDS STUDIO ARCHITETTURA</div>
      <div class="cds-mm-cart-sub">${this.rawRootNode.text || 'Mappa Concettuale'}</div>
      <div class="cds-mm-cart-meta">${this.sheetFormat} ${this.sheetOrientation} · Scala Grafica 1:1</div>
    `;
  }

  initNodeResize(node, nodeEl, ev) {
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startW = node.width || (nodeEl ? nodeEl.offsetWidth : 180);
    const startH = node.height || (nodeEl ? nodeEl.offsetHeight : 54);

    if (nodeEl) {
      nodeEl.style.maxWidth = 'none';
      nodeEl.style.minWidth = '60px';
    }

    const onMove = (moveEv) => {
      const dw = (moveEv.clientX - startX) / this.zoom;
      const dh = (moveEv.clientY - startY) / this.zoom;
      const newW = Math.max(80, Math.round(startW + dw));
      const newH = Math.max(36, Math.round(startH + dh));

      node.width = newW;
      node.height = newH;
      node.customWidth = newW;
      node.customHeight = newH;

      if (nodeEl) {
        nodeEl.style.width = `${newW}px`;
        nodeEl.style.height = `${newH}px`;
      }

      const raw = this.findRawNode(node.id);
      if (raw) {
        raw.customWidth = newW;
        raw.customHeight = newH;
        if (raw.customX === undefined) {
          raw.customX = node.x;
          raw.customY = node.y;
        }
      }

      this.updateBranchPathsRealtime();
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      MindmapEngine.resolveCollisions(this.renderedNodes, 45, 34);
      this.saveLayoutMemory();
      this.render();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
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
    if (node.tableData && node.tableData.title) {
      const trTitle = thead.createEl('tr');
      const thTitle = trTitle.createEl('th', { attr: { colspan: Math.max(2, (node.tableData.headers || []).length) } });
      thTitle.className = 'cds-mm-table-super-header';
      thTitle.textContent = node.tableData.title;
    }
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

    // Priorità di Studio
    mkFloatBtn('🔴', 'Segna come: Da Rivedere (Urgente)', () => this.setNodePriority(rawNode, 'high', '#f43f5e'));
    mkFloatBtn('🟡', 'Segna come: In Dubbio (Da approfondire)', () => this.setNodePriority(rawNode, 'medium', '#fbbf24'));
    mkFloatBtn('🟢', 'Segna come: Padroneggiato (Pronto per esame)', () => this.setNodePriority(rawNode, 'done', '#10b981'));
    if (rawNode.priority && rawNode.priority !== 'none') {
      mkFloatBtn('⚪️', 'Rimuovi Priorità', () => this.setNodePriority(rawNode, 'none', null));
    }

    const isTable = rawNode.layout === 'table';
    mkFloatBtn(isTable ? '🧠 Mappa' : '📊 Tabella', isTable ? 'Ritorna a Ramo Mappa' : 'Converti in Tabella', () => this.toggleTableLayoutSelected());
    
    if (rawNode.children && rawNode.children.length) {
      mkFloatBtn(rawNode.collapsed ? '👁️ Mostra' : '👁️ Riduci', rawNode.collapsed ? 'Espandi nodi figli' : 'Riduci e nascondi rami figli', () => {
        rawNode.collapsed = !rawNode.collapsed;
        this.saveLayoutMemory();
        this.render();
        this.triggerSave();
      });
    }

    mkFloatBtn('📷 Foto', 'Inserisci Immagine nel nodo', () => this.promptInsertImage(rawNode));
    mkFloatBtn('📄 PDF', 'Collega Documento PDF', () => this.promptInsertPdf(rawNode));
    mkFloatBtn('🔗 Link', 'Inserisci Collegamento Esterno', () => this.promptInsertLink(rawNode));

    mkFloatBtn('✏️', 'Modifica Testo (F2)', () => this.startEditing(rawNode, selectedEl));
    mkFloatBtn('🗑️', 'Elimina Nodo (Canc)', () => this.deleteSelected());

    const nodeX = parseFloat(selectedEl.style.left) || 0;
    const nodeY = parseFloat(selectedEl.style.top) || 0;
    const nodeW = parseFloat(selectedEl.style.width) || 160;
    const nodeH = parseFloat(selectedEl.style.height) || 48;

    this.floatingBar.style.left = `${nodeX + (nodeW / 2)}px`;
    if (nodeY < 75) {
      this.floatingBar.style.top = `${nodeY + nodeH + 12}px`;
      this.floatingBar.style.transform = 'translate(-50%, 0)';
    } else {
      this.floatingBar.style.top = `${nodeY - 14}px`;
      this.floatingBar.style.transform = 'translate(-50%, -100%)';
    }
  }

    promptInsertImage(node) {
    new NodeImageModal(this.app, node, (val) => {
      if (val.startsWith('http')) {
        node.text += ' ![' + 'immagine' + '](' + val + ')';
      } else {
        node.text += ' ![[' + val + ']]';
      }
      this.render();
      new Notice('📷 Immagine inserita nel nodo!');
    }).open();
  }

  promptInsertPdf(node) {
    new NodePdfModal(this.app, node, (file, page) => {
      node.text += ' [[' + file + '#page=' + page + '|📄 Pag. ' + page + ']]';
      this.render();
      new Notice('📄 Collegamento PDF aggiunto!');
    }).open();
  }

  promptInsertLink(node) {
    new NodeLinkModal(this.app, node, (url, label) => {
      node.text += ' [' + label + '](' + url + ')';
      this.render();
      new Notice('🔗 Collegamento esterno inserito!');
    }).open();
  }

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
    const modal = new MindmapExportModal(this.app, this);
    if (this.sheetFormat) modal.paperSize = this.sheetFormat;
    if (this.sheetOrientation) modal.orientation = this.sheetOrientation;
    modal.open();
  }

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
        s.nodeEl.classList.add('is-dragging-node');
        s.nodeEl.style.zIndex = '1000';
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
      s.nodeEl.classList.remove('is-dragging-node');
      s.nodeEl.style.zIndex = '';
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
        this.saveLayoutMemory();

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
        p.d = MindmapEngine.generateBranchPath(x1, y1, x2, y2, isRight, this.connectorStyle);

        const pathEl = this.svgLayer.querySelector(`[data-to="${p.toId}"]`);
        if (pathEl) {
          pathEl.setAttribute('d', p.d);
        }
      }
    }
  }

  
  
  getAncestorIds(nodeId) {
    const list = [nodeId];
    let cur = this.findRawNode(nodeId);
    while (cur && !cur.isRoot) {
      const parent = this.findParent(cur.id);
      if (!parent) break;
      list.push(parent.id);
      cur = parent;
    }
    return list;
  }

  updateHierarchyGlow(activeNodeId) {
    if (!activeNodeId || activeNodeId === 'root') {
      this.svgLayer.querySelectorAll('.cds-mm-branch-path').forEach(p => {
        p.classList.remove('is-breadcrumb-path', 'is-breadcrumb-dimmed');
      });
      this.nodesLayer.querySelectorAll('.cds-mm-node').forEach(n => {
        n.classList.remove('is-breadcrumb-node', 'is-breadcrumb-dimmed');
      });
      return;
    }

    const ancestors = new Set(this.getAncestorIds(activeNodeId));

    this.svgLayer.querySelectorAll('.cds-mm-branch-path').forEach(p => {
      const fromId = p.getAttribute('data-from');
      const toId = p.getAttribute('data-to');
      if (ancestors.has(fromId) && ancestors.has(toId)) {
        p.classList.add('is-breadcrumb-path');
        p.classList.remove('is-breadcrumb-dimmed');
      } else {
        p.classList.remove('is-breadcrumb-path');
        p.classList.add('is-breadcrumb-dimmed');
      }
    });

    this.nodesLayer.querySelectorAll('.cds-mm-node').forEach(nEl => {
      const nid = nEl.getAttribute('data-node-id');
      if (ancestors.has(nid)) {
        nEl.classList.add('is-breadcrumb-node');
        nEl.classList.remove('is-breadcrumb-dimmed');
      } else {
        nEl.classList.remove('is-breadcrumb-node');
        nEl.classList.add('is-breadcrumb-dimmed');
      }
    });
  }

  setNodePriority(rawNode, priority, color) {
    rawNode.priority = priority;
    rawNode.customColor = color;
    this.render();
    this.saveLayoutMemory();
    const lbl = priority === 'high' ? '🔴 DA RIVEDERE' : priority === 'medium' ? '🟡 IN DUBBIO' : priority === 'done' ? '🟢 PADRONEGGIATO' : '⚪️ STANDARD';
    new Notice('Stato concetto: ' + lbl);
  }

  toggleStudyMode() {
    this.isStudyMode = !this.isStudyMode;
    if (this.isStudyMode) {
      new Notice('🎓 Modalità Ripasso ATTIVA! I concetti sono coperti. Clicca o premi Spazio per verificare il ricordo.');
    } else {
      new Notice('📖 Modalità Ripasso disattivata.');
    }
    this.renderTopDock();
    this.render();
  }

  async saveLayoutMemory() {
    if (!this.plugin || !this.filePath) return;
    if (!this.plugin.settings) this.plugin.settings = { fileLayouts: {} };
    if (!this.plugin.settings.fileLayouts) this.plugin.settings.fileLayouts = {};

    const positions = {};
    const collapsed = [];

    const walk = (n) => {
      if (n.customX !== undefined || n.customY !== undefined || n.customWidth !== undefined || n.customHeight !== undefined || n.layout || n.priority || n.customColor) {
        positions[n.id] = {
          x: Math.round(n.customX !== undefined ? n.customX : (n.x || 0)),
          y: Math.round(n.customY !== undefined ? n.customY : (n.y || 0)),
          customWidth: n.customWidth,
          customHeight: n.customHeight,
          layout: n.layout,
          isOrganic: n.isOrganic,
          edgeText: n.edgeText,
          priority: n.priority,
          customColor: n.customColor
        };
      }
      if (n.collapsed) {
        collapsed.push(n.id);
      }
      if (n.children) n.children.forEach(walk);
    };
    walk(this.rawRootNode);

    this.plugin.settings.fileLayouts[this.filePath] = {
      positions,
      collapsed,
      viewMode: this.viewMode,
      detailLevel: this.detailLevel,
      connectorStyle: this.connectorStyle,
      isOrganicView: !!this.isOrganicView,
      panX: Math.round(this.panX),
      panY: Math.round(this.panY),
      zoom: Number(this.zoom.toFixed(2)),
      updatedAt: Date.now()
    };

    CUSTOM_POSITIONS_CACHE.set(this.filePath, positions);
    if (this.plugin.saveSettings) {
      await this.plugin.saveSettings();
    }
  }

  async resetLayoutMemory() {
    const clearWalk = (n) => {
      delete n.customX;
      delete n.customY;
      delete n.customWidth;
      delete n.customHeight;
      n.collapsed = false;
      if (n.children) n.children.forEach(clearWalk);
    };
    clearWalk(this.rawRootNode);

    if (this.plugin && this.plugin.settings && this.plugin.settings.fileLayouts && this.filePath) {
      delete this.plugin.settings.fileLayouts[this.filePath];
      if (this.plugin.saveSettings) {
        await this.plugin.saveSettings();
      }
    }

    if (this.filePath) {
      CUSTOM_POSITIONS_CACHE.delete(this.filePath);
    }

    new Notice('🔄 Memoria mappa cancellata: geometria automatica e distanze ottimali ripristinate!');
    this.render();
    this.fitToScreen();
  }

  resetCustomPositions() {
    this.resetLayoutMemory();
    return;

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

  deselectAll() {
    if (!this.selectedNodeId) return;
    this.selectedNodeId = null;
    this.floatingBar.style.display = 'none';
    this.updateHierarchyGlow(null);
    this.nodesLayer.querySelectorAll('.cds-mm-node.is-selected').forEach(el => el.classList.remove('is-selected'));
    
    // Rimuovi indicatori di flash temporanei nell'editor Markdown
    const flashes = document.querySelectorAll('.cds-mm-editor-flash');
    flashes.forEach(f => f.remove());

    if (this.options.onDeselect) {
      this.options.onDeselect();
    }
  }

  selectNode(nodeId) {
    this.selectedNodeId = nodeId;
    this.render();
    this.updateHierarchyGlow(nodeId);
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

  createNodeAtCoordinates(canvasX, canvasY, defaultText = 'Nuovo Concetto') {
    const parent = (this.selectedNodeId && this.selectedNodeId !== 'root')
      ? (this.findRawNode(this.selectedNodeId) || this.rawRootNode)
      : this.rawRootNode;

    if (!parent.children) parent.children = [];
    parent.collapsed = false;

    const childIdx = parent.children.length;
    const parentPath = parent.id || 'root';
    const timestamp = Date.now().toString(36).slice(-4);
    const newId = MindmapEngine.generateDeterministicId(parentPath, childIdx, defaultText) + '_' + timestamp;

    const newNode = {
      id: newId,
      text: defaultText,
      depth: (parent.depth || 0) + 1,
      type: parent.depth === 0 ? 'heading' : 'keypoint',
      children: [],
      collapsed: false,
      customX: canvasX,
      customY: canvasY,
      x: canvasX,
      y: canvasY,
      layout: 'default',
      bodyText: ''
    };

    parent.children.push(newNode);
    this.selectedNodeId = newNode.id;
    this.saveLayoutMemory();
    this.render();

    setTimeout(() => {
      const nodeEl = this.nodesLayer.querySelector(`[data-node-id="${newNode.id}"]`);
      if (nodeEl) {
        this.startEditing(newNode, nodeEl);
      }
    }, 60);
  }

  addChildToSelected(defaultText = 'Nuovo Concetto', pdfLink = null) {
    let parent = null;
    if (this.selectedNodeId) {
      parent = this.findRawNode(this.selectedNodeId);
    }
    if (!parent) {
      parent = this.rawRootNode;
    }
    parent.collapsed = false;
    if (!parent.children) parent.children = [];

    const childIdx = parent.children.length;
    const parentPath = parent.id || 'root';
    const timestamp = Date.now().toString(36).slice(-4);
    const newId = MindmapEngine.generateDeterministicId(parentPath, childIdx, defaultText) + '_' + timestamp;

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
    this.saveLayoutMemory();
    this.render();

    setTimeout(() => {
      const nodeEl = this.nodesLayer.querySelector(`[data-node-id="${newNode.id}"]`);
      if (nodeEl) {
        this.startEditing(newNode, nodeEl);
      }
    }, 60);
  }

  addSiblingToSelected(defaultText = 'Nuovo Concetto') {
    if (!this.selectedNodeId || this.selectedNodeId === 'root') {
      this.addChildToSelected(defaultText);
      return;
    }

    const parent = this.findParent(this.selectedNodeId);
    if (!parent) {
      this.addChildToSelected(defaultText);
      return;
    }

    const idx = parent.children.findIndex(c => c.id === this.selectedNodeId);
    const parentPath = parent.id || 'root';
    const childIdx = parent.children.length;
    const timestamp = Date.now().toString(36).slice(-4);
    const newId = MindmapEngine.generateDeterministicId(parentPath, childIdx, defaultText) + '_' + timestamp;

    const newNode = {
      id: newId,
      text: defaultText,
      depth: parent.depth !== undefined ? parent.depth + 1 : 1,
      type: parent.depth === 0 ? 'heading' : 'keypoint',
      children: [],
      collapsed: false,
      bodyText: '',
      layout: 'default'
    };

    if (idx !== -1) {
      parent.children.splice(idx + 1, 0, newNode);
    } else {
      parent.children.push(newNode);
    }

    this.selectedNodeId = newNode.id;
    this.saveLayoutMemory();
    this.render();

    setTimeout(() => {
      const nodeEl = this.nodesLayer.querySelector(`[data-node-id="${newNode.id}"]`);
      if (nodeEl) {
        this.startEditing(newNode, nodeEl);
      }
    }, 60);
  }

  deleteSelected() {
    if (!this.selectedNodeId || this.selectedNodeId === 'root') {
      new Notice('La radice della mappa non può essere eliminata.');
      return;
    }
    const parent = this.findParent(this.selectedNodeId);
    if (!parent) return;

    const idx = parent.children.findIndex(c => c.id === this.selectedNodeId);
    if (idx !== -1) {
      parent.children.splice(idx, 1);
      this.selectedNodeId = parent.id;
      this.saveLayoutMemory();
      this.render();
      this.triggerSave();
    }
  }

  startEditing(node, nodeEl) {
    if (this.editingInput) return;

    const rendered = (this.renderedNodes && this.renderedNodes.find(n => n.id === node.id)) || node;
    const titleEl = nodeEl ? (nodeEl.querySelector('.cds-mm-node-title') || nodeEl) : null;
    if (titleEl) titleEl.style.visibility = 'hidden';

    const input = document.createElement('textarea');
    input.className = 'cds-mm-editor-input';
    input.value = node.text || '';

    const posX = rendered.x !== undefined ? rendered.x : (nodeEl ? parseFloat(nodeEl.style.left) || 0 : 0);
    const posY = rendered.y !== undefined ? rendered.y : (nodeEl ? parseFloat(nodeEl.style.top) || 0 : 0);
    const posW = rendered.width !== undefined ? rendered.width : (nodeEl ? parseFloat(nodeEl.style.width) || 200 : 200);
    const posH = rendered.height !== undefined ? rendered.height : (nodeEl ? parseFloat(nodeEl.style.height) || 50 : 50);

    input.style.left = `${posX}px`;
    input.style.top = `${posY}px`;
    input.style.width = `${Math.max(posW, 180)}px`;
    input.style.height = `${Math.max(posH, 48)}px`;

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
      if (titleEl) titleEl.style.visibility = 'visible';
      this.saveLayoutMemory();
      this.render();
      this.triggerSave();
    };

    input.onblur = commit;
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.nodesLayer.removeChild(input);
        this.editingInput = null;
        if (titleEl) titleEl.style.visibility = 'visible';
        this.render();
      }
    };
  }

  onKeyDown(e) {
    if (this.editingInput) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.nodesLayer.removeChild(this.editingInput);
        this.editingInput = null;
        this.render();
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      this.deselectAll();
      return;
    }

    if (e.code === 'Space' && this.isStudyMode && this.selectedNodeId && this.selectedNodeId !== 'root') {
      e.preventDefault();
      if (this.revealedNodes.has(this.selectedNodeId)) {
        this.revealedNodes.delete(this.selectedNodeId);
      } else {
        this.revealedNodes.add(this.selectedNodeId);
      }
      this.render();
      return;
    }

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
    
    // Cliccando sullo sfondo vuoto della mappa deseleziona il nodo ed esce dalla modalità evidenziazione
    if (this.selectedNodeId) {
      this.deselectAll();
    }

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
      onSaveMarkdown: null, // SICUREZZA: Mai sovrascrivere o troncare la nota master in visualizzazione mappa! Evita conflitti e corruzioni.
      onPdfJump: (pdfLink) => {
        this.plugin.jumpToPdfAnnotation(pdfLink);
      },
      onNodeClick: (node) => {
        this.jumpToNodeInMarkdown(node);
      }
    });

    this.canvas.centerRoot();
  }

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
    this.settings = Object.assign({ fileLayouts: {} }, await this.loadData());
    console.log('Loading CDS Mindmap Suite v1.7.4 (Proportional Radial Sectors, Dedicated Table Branches, Zero-Collision 2D Solver, Canvas Resize & Organic View) (Organic View, Canvas-Style Resizing, Branch Labels, Zero-Overlap 2D Solver & Safe Table Preservation)');

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

    // Codeblock processors
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

  async saveSettings() {
    await this.saveData(this.settings);
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
