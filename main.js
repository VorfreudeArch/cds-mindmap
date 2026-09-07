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
  static findNodeInTree(node, id) {
    if (node.id === id) return node;
    if (node.children) {
      for (const c of node.children) {
        const found = MindmapEngine.findNodeInTree(c, id);
        if (found) return found;
      }
    }
    return null;
  }

  static findNodeByText(node, text) {
    if (!text) return null;
    const cleanTarget = text.trim().toLowerCase();
    if ((node.text || '').trim().toLowerCase() === cleanTarget) return node;
    if (node.children) {
      for (const c of node.children) {
        const found = MindmapEngine.findNodeByText(c, text);
        if (found) return found;
      }
    }
    return null;
  }

  // RE-INIEZIONE PERSISTENTE DEI NODI CREATI DA CANVAS (v1.8.0 Multi-Pass & Fallback)
  static reinjectAddedNodes(rootNode, filePath) {
    if (!filePath) return;
    const layoutData = CUSTOM_POSITIONS_CACHE.get(filePath + '_layout');
    if (!layoutData || !layoutData.addedNodes || !layoutData.addedNodes.length) return;

    let pending = [...layoutData.addedNodes];
    let maxPasses = 5;

    while (pending.length > 0 && maxPasses-- > 0) {
      const nextPending = [];
      for (const an of pending) {
        let p = MindmapEngine.findNodeInTree(rootNode, an.parentId);
        if (!p && an.parentText) {
          p = MindmapEngine.findNodeByText(rootNode, an.parentText);
        }

        if (p) {
          if (!p.children) p.children = [];
          let existing = p.children.find(c => c.id === an.id);
          if (!existing) {
            p.children.push({
              id: an.id,
              text: an.text,
              depth: an.depth || ((p.depth || 0) + 1),
              type: an.type || 'keypoint',
              children: [],
              collapsed: false,
              customX: an.customX,
              customY: an.customY,
              customWidth: an.customWidth,
              customHeight: an.customHeight,
              customColor: an.customColor,
              priority: an.priority,
              isCanvasAdded: true,
              bodyText: an.bodyText || '',
              pdfLink: an.pdfLink || null,
              images: an.images || null,
              tableData: an.tableData || null,
              layout: an.layout || 'default'
            });
          }
        } else {
          nextPending.push(an);
        }
      }

      if (nextPending.length === pending.length) {
        // Se rimangono nodi orfani, attaccali alla radice per non perderli MAI!
        for (const an of nextPending) {
          if (!rootNode.children.some(c => c.id === an.id)) {
            rootNode.children.push({
              id: an.id,
              text: an.text,
              depth: 1,
              type: an.type || 'keypoint',
              children: [],
              collapsed: false,
              customX: an.customX,
              customY: an.customY,
              customWidth: an.customWidth,
              customHeight: an.customHeight,
              customColor: an.customColor,
              priority: an.priority,
              isCanvasAdded: true,
              bodyText: an.bodyText || '',
              pdfLink: an.pdfLink || null,
              images: an.images || null,
              tableData: an.tableData || null,
              layout: an.layout || 'default'
            });
          }
        }
        break;
      }
      pending = nextPending;
    }
  }

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

    /**
   * Parser avanzato per Diagrammi e Grafici ASCII / Unicode (es. Schemi Semper a croce, Flowchart, Box, Alberi)
   */
  static parseAsciiDiagram(lines, parentNode, startLine = 0) {
    if (!lines || lines.length < 2) return null;

    const hasBoxes = lines.some(l => /\[[^\]]{2,}\]/.test(l));
    const hasTree = lines.some(l => /[├└]──/.test(l));
    const hasDiagramChars = lines.some(l => /[│─┼┌┐└┘├┤┬┴◄►▲▼\<\>]|-->|<--/.test(l));

    if (!hasBoxes && !hasDiagramChars && !hasTree) return null;

    const rawBlockText = lines.join('\n');

    // 1. Struttura ad Albero Unicode (├── ... └── ...)
    if (hasTree) {
      let treeTitle = '';
      const elements = [];
      for (const l of lines) {
        const t = l.trim();
        if (!t) continue;
        const m = t.match(/[├└]──\s*(.+)/);
        if (m) {
          elements.push({ text: m[1].trim(), relativePos: 'right' });
        } else if (!treeTitle && !/[│─┼┌┐└┘├┤┬┴]/.test(t)) {
          treeTitle = t.replace(/^#+\s*/, '').trim();
        }
      }
      if (elements.length >= 2) {
        return {
          title: treeTitle || 'Struttura Ad Albero',
          elements,
          type: 'tree',
          rawText: rawBlockText
        };
      }
    }

    // 2. Estrazione Titolo Diagramma
    let title = '';
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx].trim();
      if (!l) continue;
      if (/\[[^\]]+\]|[│─┼┌┐└┘├┤┬┴◄►▲▼]/.test(l)) {
        break;
      }
      if (!title) {
        title = l.replace(/^#+\s*/, '').trim();
      }
    }
    if (!title) title = 'Diagramma Concettuale';

    // 3. Estrazione nodi nei box [ ... ] con coordinate riga e colonna
    const elements = [];
    const boxRegex = /\[([^\]]+)\]/g;

    for (let rowIdx = 0; rowIdx < lines.length; rowIdx++) {
      const line = lines[rowIdx];
      let match;
      while ((match = boxRegex.exec(line)) !== null) {
        const nodeText = match[1].trim();
        const colStart = match.index;
        const colEnd = colStart + match[0].length;

        // Cerca eventuale annotazione sottostante (es. "(Umschließung)" sotto "[ RECINTO ]")
        let subtitle = '';
        if (rowIdx + 1 < lines.length) {
          const nextLine = lines[rowIdx + 1];
          const subMatches = nextLine.match(/\(([^)]+)\)/g);
          if (subMatches) {
            for (const sm of subMatches) {
              const smIdx = nextLine.indexOf(sm);
              if (Math.abs(smIdx - colStart) < 18) {
                subtitle = sm.replace(/[()]/g, '').trim();
                break;
              }
            }
          }
        }

        const fullText = (subtitle && !nodeText.includes(subtitle)) 
          ? `${nodeText} (${subtitle})` 
          : nodeText;

        elements.push({
          text: fullText,
          rawText: nodeText,
          subtitle,
          row: rowIdx,
          col: colStart,
          centerCol: (colStart + colEnd) / 2
        });
      }
    }

    if (elements.length < 2) {
      // Flow orizzontale non-boxato: A ──► B ──► C.
      // SENZA frecce esplicite NON estrarre elementi: blocchi ASCII con soli
      // connettori (/ \ _ │) andrebbero frammentati in nodi spazzatura
      // (es. "A. DINAMISMO ARMONICO B. DINAMISMO DRAMMATICO" → decine di nodi).
      const hasArrows = /-->|<--|[►◄]|─[►>]|─[◄<]/.test(rawBlockText);
      if (!hasArrows) return null;
      const flowParts = rawBlockText.split(/[─\-]*[►>]+[─\-]*|[─\-]*[◄<]+[─\-]*|\n/);
      const cleaned = flowParts.map(p => p.trim().replace(/^[\[\(]|[\]\)]$/g, '')).filter(p => p && !/^[│─┼┌┐└┘├┤┬┴◄►▲▼\/\\_=\s·•]+$/.test(p));
      if (cleaned.length >= 2) {
        return {
          title: title !== cleaned[0] ? title : 'Processo Sequenziale',
          elements: cleaned.map(c => ({ text: c, relativePos: 'right' })),
          type: 'flow',
          rawText: rawBlockText
        };
      }
      return null;
    }

    // 4. Calcolo Geometria Spaziale (Top, Bottom, Left, Right)
    const minRow = Math.min(...elements.map(e => e.row));
    const maxRow = Math.max(...elements.map(e => e.row));
    const centerRow = (minRow + maxRow) / 2;

    const minCol = Math.min(...elements.map(e => e.col));
    const maxCol = Math.max(...elements.map(e => e.col));
    const centerCol = (minCol + maxCol) / 2;

    for (const e of elements) {
      const dRow = e.row - centerRow;
      const dCol = e.centerCol - centerCol;
      // Normalizzazione aspect ratio (altezza riga ~ 2.75x larghezza carattere monospace)
      const normR = dRow * 2.75;
      const normC = dCol * 1.0;

      if (Math.abs(normC) >= Math.abs(normR)) {
        e.relativePos = normC >= 0 ? 'right' : 'left';
      } else {
        e.relativePos = normR >= 0 ? 'bottom' : 'top';
      }
    }

    return {
      title,
      elements,
      type: 'diagram',
      rawText: rawBlockText
    };
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

    let inCodeBlock = false;
    let codeBlockLines = [];
    let codeBlockStartLine = 0;
    let activeTable = null; // Buffer per tabelle o diagrammi non racchiusi in codeblock

    for (let i = 0; i < lines.length; i++) {
      const lineNum = lineOffset + i;
      const line = lines[i];
      const trimmed = line.trim();

      // 1. Gestione blocchi di codice recintati (``` ... ```)
      if (trimmed.startsWith('```')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockLines = [];
          codeBlockStartLine = lineNum;
          continue;
        } else {
          inCodeBlock = false;
          const parent = currentParentStack[currentParentStack.length - 1];
          if (parent) {
            let tableData = null;
            if (codeBlockLines.some(l => /^[┌│├└]/.test(l.trim()))) {
              tableData = MindmapEngine.parseBoxDrawingTable(codeBlockLines);
            } else if (codeBlockLines.filter(l => l.trim().startsWith('|') && l.trim().endsWith('|')).length >= 2) {
              const validLines = codeBlockLines.filter(l => l.trim().startsWith('|') && l.trim().endsWith('|'));
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
              const childIdx = parent.children.length;
              parent.children.push({
                id: `${parent.id}_tbl_${childIdx}`,
                text: `📊 ${tblTitle.slice(0, 36)}`,
                depth: (parent.depth || 1) + 1,
                type: 'table',
                layout: 'table',
                tableData,
                children: [],
                collapsed: false,
                sourceLine: codeBlockStartLine
              });
            } else {
              const diagData = MindmapEngine.parseAsciiDiagram(codeBlockLines, parent, codeBlockStartLine);
              if (diagData && diagData.elements && diagData.elements.length > 0) {
                const childIdx = parent.children.length;
                const parentPath = pathStack.join('_');
                const diagNodeId = MindmapEngine.generateDeterministicId(parentPath, childIdx, diagData.title);
                const diagNode = {
                  id: diagNodeId,
                  text: `📐 ${diagData.title}`,
                  depth: (parent.depth || 1) + 1,
                  type: 'heading',
                  bodyText: diagData.rawText,
                  children: [],
                  collapsed: false,
                  sourceLine: codeBlockStartLine,
                  layout: 'default'
                };
                parent.children.push(diagNode);

                diagData.elements.forEach((elem, elIdx) => {
                  const elemId = MindmapEngine.generateDeterministicId(diagNodeId, elIdx, elem.text);
                  diagNode.children.push({
                    id: elemId,
                    text: elem.text,
                    depth: diagNode.depth + 1,
                    type: 'keypoint',
                    children: [],
                    collapsed: false,
                    manualSide: elem.relativePos === 'left' ? 'left' : (elem.relativePos === 'right' ? 'right' : undefined),
                    relativePos: elem.relativePos,
                    sourceLine: codeBlockStartLine,
                    layout: 'default'
                  });
                });
              } else {
                parent.bodyText += '\n```\n' + codeBlockLines.join('\n') + '\n```';
              }
            }
          }
          continue;
        }
      }

      if (inCodeBlock) {
        codeBlockLines.push(line);
        continue;
      }

      // Rilevamento righe di tabella (Markdown | o Box-Drawing ┌│├└) o Diagrammi ASCII / Codeblocks
      const isMdTable = trimmed.startsWith('|') && trimmed.endsWith('|');
      const isBoxTable = /^[┌│├└]/.test(trimmed) || trimmed.startsWith('```') || /\[[^\]]{2,}\]|[│─┼┌┐└┘├┤┬┴◄►▲▼]/.test(trimmed);

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
        } else {
          // Verifica se il blocco raccolto è un Diagramma o Schema ASCII (es. Semper, Flowchart)
          const diagData = MindmapEngine.parseAsciiDiagram(t.rawLines, t.parent, t.startLine);
          if (diagData && diagData.elements && diagData.elements.length > 0) {
            const childIdx = t.parent.children.length;
            const parentPath = pathStack.join('_');
            const diagNodeId = MindmapEngine.generateDeterministicId(parentPath, childIdx, diagData.title);
            const diagNode = {
              id: diagNodeId,
              text: `📐 ${diagData.title}`,
              depth: (t.parent.depth || 1) + 1,
              type: 'heading',
              bodyText: diagData.rawText,
              children: [],
              collapsed: false,
              sourceLine: t.startLine,
              layout: 'default'
            };
            t.parent.children.push(diagNode);

            diagData.elements.forEach((elem, elIdx) => {
              const elemId = MindmapEngine.generateDeterministicId(diagNodeId, elIdx, elem.text);
              const elemNode = {
                id: elemId,
                text: elem.text,
                depth: diagNode.depth + 1,
                type: 'keypoint',
                children: [],
                collapsed: false,
                manualSide: elem.relativePos === 'left' ? 'left' : (elem.relativePos === 'right' ? 'right' : undefined),
                relativePos: elem.relativePos,
                sourceLine: t.startLine,
                layout: 'default'
              };
              diagNode.children.push(elemNode);
            });
          }
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

    // RE-INIEZIONE PERSISTENTE DEI NODI CREATI DA CANVAS (v1.8.0 Multi-Pass Infallibile)
    MindmapEngine.reinjectAddedNodes(rootNode, filePath);
    return rootNode;
  }

  // ==========================================================================
  // METODO v1.8.1: ESPORTAZIONE NATIVA OBSIDIAN CANVAS (.canvas)
  // ==========================================================================
  static exportToObsidianCanvas(rootNode, options = {}) {
    const detailLevel = options.detailLevel || 'keypoints';
    const viewMode = options.viewMode || 'bilateral';
    const customGroups = options.groups || [];

    // Densità di spaziatura (stessi valori della vista interattiva: v1.8.0)
    const density = options.spacingDensity || 'compact';
    let hGap = 45, vGap = 12, cGap = 16;
    if (density === 'ultra-compact') { hGap = 35; vGap = 8; cGap = 10; }
    else if (density === 'standard') { hGap = 65; vGap = 18; cGap = 24; }

    const filteredTree = MindmapEngine.filterTreeByDetail(rootNode, detailLevel);

    // Calcolo dimensioni reali delle schede Canvas in base al testo effettivo
    function measureCanvasNodes(node) {
      let nodeText = '';
      if (node.depth === 0) {
        nodeText = '# ' + node.text;
      } else if (node.depth === 1 || node.depth === 2) {
        nodeText = '### ' + node.text;
      } else {
        nodeText = '**' + node.text + '**';
      }

      if (node.bodyText && node.bodyText.trim()) {
        nodeText += '\n\n' + node.bodyText.trim();
      }
      node.canvasText = nodeText;

      const len = nodeText.length;
      if (node.layout === 'table') {
        node.width = 520;
        node.height = 280;
      } else if (len > 1200) {
        node.width = 480;
        node.height = Math.min(650, Math.ceil(len / 48) * 22 + 60);
      } else if (len > 600) {
        node.width = 440;
        node.height = Math.min(480, Math.ceil(len / 44) * 22 + 50);
      } else if (len > 250) {
        node.width = 380;
        node.height = Math.min(340, Math.ceil(len / 38) * 22 + 40);
      } else if (len > 80) {
        node.width = 320;
        node.height = Math.min(220, Math.ceil(len / 32) * 22 + 35);
      } else {
        node.width = 260;
        node.height = Math.max(70, Math.min(130, node.height || 70));
      }

      if (node.children) {
        for (const ch of node.children) measureCanvasNodes(ch);
      }
    }
    measureCanvasNodes(filteredTree);

    // Layout compatto ed ergonomico per Obsidian Canvas (rispetta la densità scelta)
    const layoutOpts = {
      skipMeasure: true,
      detailLevel,
      horizontalGap: hGap,
      verticalGap: vGap,
      chapterGap: cGap
    };

    let layout;
    if (viewMode === 'radial') {
      layout = MindmapEngine.computeRadialLayout(filteredTree, layoutOpts);
    } else if (viewMode === 'bilateral') {
      layout = MindmapEngine.computeBilateralLayout(filteredTree, layoutOpts);
    } else {
      layout = MindmapEngine.computeRightLayout(filteredTree, layoutOpts);
    }

    const canvasNodes = [];
    const canvasEdges = [];

    // Colori Obsidian Canvas nativi (1-6)
    const depthColors = ['5', '1', '2', '4', '6', '3'];

    layout.nodes.forEach(n => {
      let color = depthColors[Math.min(n.depth, depthColors.length - 1)];
      canvasNodes.push({
        id: n.id,
        type: 'text',
        text: n.canvasText || n.text,
        x: Math.round(n.x),
        y: Math.round(n.y),
        width: Math.round(n.width),
        height: Math.round(n.height),
        color
      });
    });

    // Gruppi personalizzati esportati come nodi 'group' nativi
    if (customGroups && customGroups.length > 0) {
      customGroups.forEach(grp => {
        const members = layout.nodes.filter(n => grp.nodeIds && grp.nodeIds.includes(n.id));
        if (!members.length) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const m of members) {
          minX = Math.min(minX, m.x);
          minY = Math.min(minY, m.y);
          maxX = Math.max(maxX, m.x + m.width);
          maxY = Math.max(maxY, m.y + m.height);
        }

        const pad = 25;
        canvasNodes.push({
          id: grp.id,
          type: 'group',
          label: grp.title || 'Gruppo',
          x: Math.round(minX - pad),
          y: Math.round(minY - pad),
          width: Math.round(maxX - minX + pad * 2),
          height: Math.round(maxY - minY + pad * 2),
          color: grp.color ? '4' : undefined
        });
      });
    }

    // Connessioni ed archi
    const paths = layout.paths || layout.branchPaths || [];
    paths.forEach(b => {
      if (!b.fromId || !b.toId) return;
      const fromNode = layout.nodes.find(n => n.id === b.fromId);
      const toNode = layout.nodes.find(n => n.id === b.toId);
      if (!fromNode || !toNode) return;

      const dx = (toNode.x + toNode.width / 2) - (fromNode.x + fromNode.width / 2);
      const dy = (toNode.y + toNode.height / 2) - (fromNode.y + fromNode.height / 2);

      let fromSide = 'right';
      let toSide = 'left';

      if (Math.abs(dx) >= Math.abs(dy)) {
        if (dx >= 0) {
          fromSide = 'right';
          toSide = 'left';
        } else {
          fromSide = 'left';
          toSide = 'right';
        }
      } else {
        if (dy >= 0) {
          fromSide = 'bottom';
          toSide = 'top';
        } else {
          fromSide = 'top';
          toSide = 'bottom';
        }
      }

      canvasEdges.push({
        id: 'edge_' + b.fromId + '_' + b.toId,
        fromNode: b.fromId,
        fromSide,
        toNode: b.toId,
        toSide,
        label: b.edgeText || undefined
      });
    });

    return {
      nodes: canvasNodes,
      edges: canvasEdges
    };
  }

  static filterTreeByDetail(node, level = 'keypoints') {
    const clone = {
      ...node,
      children: []
    };

    if (node.children && node.children.length) {
      const hasHeadings = node.children.some(c => c.type === 'heading');
      for (const child of node.children) {
        if (level === 'titles') {
          // Se ci sono intestazioni, filtra per intestazioni. Se la nota è ad elenchi (senza H1/H2), mantieni il primo livello per non svuotare la mappa.
          if (hasHeadings && child.type !== 'heading') {
            continue;
          }
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

    // Snapshot delle posizioni ideali (pre-spostamento): servono al passaggio
    // di ricompattamento finale per evitare spazi vuoti e dispersioni eccessive.
    for (const n of nodes) {
      n._idealX = n.x;
      n._idealY = n.y;
    }

    const root = nodes.find(n => n.isRoot);
    const rootPadX = 60;
    const rootPadY = 40;

    for (let iter = 0; iter < 60; iter++) {
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
            const yOverlap = Math.min(aBottom, bBottom) - Math.max(a.y, b.y);
            const aCustom = a.customX !== undefined || a.customY !== undefined;
            const bCustom = b.customX !== undefined || b.customY !== undefined;

            // Separa lungo l'asse di MINIMA penetrazione: sposta meno e in modo
            // più pulito (evita cascate di spostamenti che allargano la mappa).
            // In caso di collisione con un nodo spostato a mano (custom), spingi
            // PREFERIBILMENTE il nodo automatico, così il nodo dell'utente resta
            // dove lo ha messo.
            const pushYaxis = yOverlap < xOverlap;
            if (pushYaxis) {
              if (aCustom && !bCustom) {
                const pushY = (aBottom + minGapY) - b.y;
                b.y += pushY;
                if (b.customY !== undefined) b.customY += pushY;
              } else if (bCustom && !aCustom) {
                const pushY = (bBottom + minGapY) - a.y;
                a.y += pushY;
                if (a.customY !== undefined) a.customY += pushY;
              } else if (a.y <= b.y) {
                const pushY = (aBottom + minGapY) - b.y;
                b.y += pushY;
                if (b.customY !== undefined) b.customY += pushY;
              } else {
                const pushY = (bBottom + minGapY) - a.y;
                a.y += pushY;
                if (a.customY !== undefined) a.customY += pushY;
              }
            } else {
              if (aCustom && !bCustom) {
                const pushX = (aRight + minGapX) - b.x;
                b.x += pushX;
                if (b.customX !== undefined) b.customX += pushX;
              } else if (bCustom && !aCustom) {
                const pushX = (bRight + minGapX) - a.x;
                a.x += pushX;
                if (a.customX !== undefined) a.customX += pushX;
              } else if (a.x <= b.x) {
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

    // Ricompattamento: riavvicina ogni nodo alla sua posizione ideale quanto più
    // possibile SENZA creare nuove sovrapposizioni → niente buchi né dispersioni.
    for (const a of nodes) {
      if (a.isRoot) continue;
      const dx = a.x - a._idealX;
      const dy = a.y - a._idealY;
      if (dx === 0 && dy === 0) continue;
      // Ricerca binaria: lo = t non sicuro, hi = t sicuro. Convergiamo sul PIÙ
      // PICCOLO t sicuro (il più vicino possibile alla posizione ideale).
      let lo = 0, hi = 1;
      for (let s = 0; s < 16; s++) {
        const mid = (lo + hi) / 2;
        const ax = a._idealX + dx * mid;
        const ay = a._idealY + dy * mid;
        if (MindmapEngine.collidesAt(nodes, a, ax, ay, minGapX, minGapY)) lo = mid;
        else hi = mid;
      }
      a.x = a._idealX + dx * hi;
      a.y = a._idealY + dy * hi;
      if (a.customX !== undefined) a.customX = a.x;
      if (a.customY !== undefined) a.customY = a.y;
    }

    for (const n of nodes) {
      delete n._idealX;
      delete n._idealY;
    }
  }

  // Verifica se il rettangolo (x, y, self.width, self.height) collide con uno
  // degli altri nodi (con margine minimo minGapX/minGapY).
  static collidesAt(nodes, self, x, y, minGapX, minGapY) {
    for (const b of nodes) {
      if (b === self) continue;
      const ovX = Math.min(x + self.width + minGapX, b.x + b.width + minGapX) - Math.max(x, b.x);
      const ovY = Math.min(y + self.height + minGapY, b.y + b.height + minGapY) - Math.max(y, b.y);
      if (ovX > 0 && ovY > 0) return true;
    }
    return false;
  }

  // Riallinea ogni sottoalbero al proprio genitore: le collisioni spostano i
  // nodi singolarmente e possono sbilanciare un blocco figli rispetto al padre,
  // generando rami obliqui che si incrociano. Questo passaggio sposta l'INTERO
  // blocco discendente in verticale (quanto basta, senza creare collisioni) per
  // riportare il centro dei figli allineato col centro del genitore.
  static rebalanceSubtrees(renderedNodes, minGapX, minGapY) {
    const map = new Map();
    for (const n of renderedNodes) map.set(n.id, n);
    const collectDesc = (node, out) => {
      if (!node.children) return;
      for (const c of node.children) {
        const cm = map.get(c.id);
        if (!cm) continue;
        out.push(cm);
        collectDesc(cm, out);
      }
    };
    for (const parent of renderedNodes) {
      if (parent.isRoot || !parent.children || !parent.children.length || parent.collapsed || parent.layout === 'table') continue;
      const kids = parent.children.map((c) => map.get(c.id)).filter(Boolean);
      if (!kids.length) continue;
      let kidsMinY = Infinity, kidsMaxY = -Infinity;
      for (const k of kids) { kidsMinY = Math.min(kidsMinY, k.y); kidsMaxY = Math.max(kidsMaxY, k.y + k.height); }
      const delta = (parent.y + parent.height / 2) - (kidsMinY + kidsMaxY) / 2;
      if (Math.abs(delta) < 1) continue;
      const sub = [];
      collectDesc(parent, sub);
      if (!sub.length) continue;
      // Rispetta i nodi posizionati a mano (customX/customY): un sottoalbero che
      // contiene nodi spostati dall'utente NON va riallineato automaticamente.
      let hasCustom = kids.some((k) => k.customX !== undefined || k.customY !== undefined);
      if (!hasCustom) hasCustom = sub.some((n) => n.customX !== undefined || n.customY !== undefined);
      if (hasCustom) continue;
      const moving = new Set(sub.map((n) => n.id));
      const sign = Math.sign(delta);
      const safeShift = (amount) => {
        for (const n of sub) {
          const ny = n.y + sign * amount;
          for (const b of renderedNodes) {
            if (b === n || moving.has(b.id)) continue;
            const ovX = Math.min(n.x + n.width + minGapX, b.x + b.width + minGapX) - Math.max(n.x, b.x);
            const ovY = Math.min(ny + n.height + minGapY, b.y + b.height + minGapY) - Math.max(ny, b.y);
            if (ovX > 0 && ovY > 0) return false;
          }
        }
        return true;
      };
      let lo = 0, hi = Math.abs(delta);
      for (let s = 0; s < 14; s++) {
        const mid = (lo + hi) / 2;
        if (safeShift(mid)) lo = mid; else hi = mid;
      }
      if (lo >= 1) for (const n of sub) n.y += sign * lo;
    }
  }

  // Rigenera i rami di collegamento dalle posizioni FINALI dei nodi (dopo la
  // risoluzione delle collisioni): i rami restano sempre agganciati ai nodi veri.
  static rebuildBranchPaths(renderedNodes, branchPaths, connectorStyle = 'curved') {
    const nodeMap = new Map();
    for (const n of renderedNodes) nodeMap.set(n.id, n);
    const root = renderedNodes.find(n => n.isRoot);
    const out = [];
    const connect = (pNode) => {
      if (!pNode.children || !pNode.children.length || pNode.collapsed || pNode.layout === 'table') return;
      for (const ch of pNode.children) {
        if (!nodeMap.has(ch.id)) continue;
        const isRight = (ch.x + ch.width / 2) >= (pNode.x + pNode.width / 2);
        const startX = isRight ? pNode.x + pNode.width : pNode.x;
        const startYPoint = pNode.y + (pNode.height / 2);
        const targetX = isRight ? ch.x : ch.x + ch.width;
        const targetYPoint = ch.y + (ch.height / 2);
        out.push({
          d: MindmapEngine.generateBranchPath(startX, startYPoint, targetX, targetYPoint, isRight, connectorStyle),
          color: ch.color || pNode.color || '#38bdf8',
          fromId: pNode.id,
          toId: ch.id,
          edgeText: ch.edgeText || ''
        });
        connect(ch);
      }
    };
    if (root) connect(root);
    else for (const n of renderedNodes) if (n.children && n.children.length) connect(n);
    branchPaths.length = 0;
    for (const p of out) branchPaths.push(p);
  }

  static measureNode(node, detailLevel = 'keypoints') {
    const text = node.text || '';
    const cleanText = text.replace(/\[\[.*?\]\]/g, 'Link').replace(/\*\*|==|\*|`/g, '');
    const rawLines = cleanText.split('\n');
    const maxLineLen = rawLines.reduce((max, l) => Math.max(max, l.length), 0);
    const totalLen = cleanText.length;

    // Dimensionamento orizzontale ottimizzato (v1.8.8): espansione orizzontale fino a 460px
    // Evita le torri verticali chilometriche e distribuisce i testi ampi in schede panoramiche
    let w = 240;
    if (node.isRoot) {
      w = Math.max(260, Math.min(480, maxLineLen * 9.2 + 50));
    } else if (node.layout === 'table') {
      w = 480;
    } else if (totalLen > 250) {
      w = 440;
    } else if (totalLen > 120) {
      w = 360;
    } else if (totalLen > 50) {
      w = 280;
    } else {
      w = Math.max(180, Math.min(260, maxLineLen * 8.6 + 38));
    }

    const printableWidth = Math.max(140, w - 36);
    const charsPerLine = Math.max(18, Math.floor(printableWidth / 7.5));

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

    // In modalità sintesi / keypoints, limita l'altezza visiva a max 5 righe per evitare lo sviluppo a grattacielo
    if (detailLevel === 'keypoints' && !node.isExpanded && wrappedLineCount > 5) {
      wrappedLineCount = 5;
    }

    // Line-height a 19px compatto
    let h = wrappedLineCount * 19 + 26 + (node.depth <= 1 ? 22 : 14);

    if (node.images && node.images.length) {
      w = Math.max(w, 280);
      h += 130;
    }

    if (node.layout === 'table') {
      const rowCount = (node.tableData && node.tableData.rows) ? node.tableData.rows.length : (node.children ? node.children.length : 1);
      h = Math.max(80, 80 + rowCount * 28);
    } else {
      const hasFullText = (detailLevel === 'full' || node.isExpanded) && node.bodyText && node.bodyText.trim();
      if (hasFullText) {
        const bodyLen = node.bodyText.length;
        if (bodyLen > 700) w = Math.max(w, 500);
        else if (bodyLen > 350) w = Math.max(w, 420);
        else if (bodyLen > 120) w = Math.max(w, 340);

        const bodyPrintableW = Math.max(160, w - 32);
        const bodyCharsPerLine = Math.max(22, Math.floor(bodyPrintableW / 6.6));

        let bodyWrappedLines = 0;
        const bodyParagraphs = node.bodyText.split('\n');
        for (const bp of bodyParagraphs) {
          const trimmed = bp.trim();
          if (!trimmed) bodyWrappedLines += 0.5;
          else bodyWrappedLines += Math.max(1, Math.ceil(trimmed.length / bodyCharsPerLine));
        }
        const bodyHeight = Math.round(bodyWrappedLines * 17 + 14);
        h += bodyHeight;
      }

      if (node.pdfLink) {
        h += 24;
        w = Math.max(w, 210);
      }
    }

    // Titolo Centrale Root
    if (node.isRoot) {
      w = Math.max(260, Math.min(480, maxLineLen * 9.2 + 50));
      h = Math.max(68, h);
    }

    node.width = node.customWidth ? Math.max(80, node.customWidth) : w;
    node.height = node.customHeight ? Math.max(node.customHeight, h) : h;

    if (node.children && node.children.length && node.layout !== 'table' && !node.collapsed) {
      for (const child of node.children) {
        MindmapEngine.measureNode(child, detailLevel);
      }
    }

    return { width: node.width, height: node.height };
  }

  // Helper diramazione a ventaglio su più colonne (v1.8.8)
  static canFanOut(children) {
    if (!children || children.length < 4) return false;
    // Non fannare se ci sono tabelle per mantenere l'integrità tabellare
    if (children.some(c => c.layout === 'table')) return false;
    // Consenti fanning se la profondità dei sotto-alberi è ragionevole (<= 2 livelli di discendenti)
    const hasTooDeepDescendants = children.some(c => 
      c.children && c.children.some(gc => 
        gc.children && gc.children.some(ggc => ggc.children && ggc.children.length > 0)
      )
    );
    if (hasTooDeepDescendants) return false;
    return true;
  }

  // ==========================================================================
  // LAYOUT 1: RADIALE 360° AD ANGOLI PROPORZIONALI (DISTANZE AMPIE E ANTI-COLLISIONE)
  // ==========================================================================
  static computeRadialLayout(rootNode, options = {}) {
    const detailLevel = options.detailLevel || 'keypoints';
    const horizontalGap = options.horizontalGap || 95;
    const verticalGap = options.verticalGap || 24;
    const connectorStyle = options.connectorStyle || 'curved';

    if (!options.skipMeasure) MindmapEngine.measureNode(rootNode, detailLevel);

    let cx = options.cx || 2400;
    let cy = options.cy || 1800;

    // Radice spostabile con frecce/drag (v1.9.4): se ha una posizione custom
    // salvata, usala come centro e ancoraci i rami automatici.
    if (rootNode.customX !== undefined && rootNode.customY !== undefined) {
      cx = rootNode.customX + (rootNode.width / 2);
      cy = rootNode.customY + (rootNode.height / 2);
    }

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
      MindmapEngine.computeSubtreeHeight(c, verticalGap, horizontalGap, options);
      totalSubtreeH += (c.subtreeHeight || 120);
    });

    // Raggio contenuto (ellisse più compatta e rotonda): meno dispersione
    // orizzontale e meno spazi vuoti ai lati della mappa radiale.
    const baseR = Math.max(430, Math.min(1400, (totalSubtreeH / (2 * Math.PI)) * 1.25));
    const rx = baseR * 1.08;
    const ry = baseR * 0.92;

    // Ordine cronologico discendente a 360°: parte dalle ore 12 (-Math.PI/2) e procede in senso orario
    let currentAngle = -Math.PI / 2;

    for (let i = 0; i < N; i++) {
      const chap = chapters[i];
      const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
      chap.color = color;

      const sectorAngle = (2 * Math.PI) * ((chap.subtreeHeight || 120) / Math.max(1, totalSubtreeH));
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

      const actualIsRight = (chap.x + chap.width / 2) >= (rootNode.x + rootNode.width / 2);
      const startX = actualIsRight ? rootNode.x + rootNode.width : rootNode.x;
      const startY = rootNode.y + (rootNode.height / 2);
      const targetX = actualIsRight ? chap.x : chap.x + chap.width;
      const targetY = chap.y + (chap.height / 2);

      branchPaths.push({
        d: MindmapEngine.generateBranchPath(startX, startY, targetX, targetY, actualIsRight, connectorStyle),
        color,
        fromId: rootNode.id,
        toId: chap.id,
        edgeText: chap.edgeText || ''
      });

      MindmapEngine.positionSubChildren(chap, color, chap.direction, horizontalGap, renderedNodes, branchPaths, verticalGap, connectorStyle);
    }

    MindmapEngine.resolveCollisions(renderedNodes, 35, 20);
    MindmapEngine.rebalanceSubtrees(renderedNodes, 35, 20);
    // Rigenera i rami dalle posizioni finali: dopo lo spostamento dei nodi i
    // percorsi precedenti non sarebbero più agganciati ai bordi reali.
    MindmapEngine.rebuildBranchPaths(renderedNodes, branchPaths, connectorStyle);
    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }

  static computeSubtreeHeight(node, verticalGap = 12, horizontalGap = 45) {
    const selfH = node.height || 44;
    if (!node.children || !node.children.length || node.layout === 'table' || node.collapsed) {
      node.subtreeHeight = selfH + verticalGap;
      node.subtreeWidth = node.width || 200;
      node.fannedCols = 1;
      node.colGroups = [[node]];
      return node.subtreeHeight;
    }

    // Calcolo ricorsivo iniziale
    for (const child of node.children) {
      MindmapEngine.computeSubtreeHeight(child, verticalGap, horizontalGap);
    }

    const numChildren = node.children.length;
    const totalLinearH = node.children.reduce((s, c) => s + (c.subtreeHeight || c.height || 40), 0);

    // Bilanciamento orizzontale a 2 o 3 colonne per evitare torri verticali
    let numCols = 1;
    if (numChildren >= 3 && totalLinearH > 400) {
      numCols = (totalLinearH > 1200 || numChildren >= 8) ? 3 : 2;
    }

    if (numCols > 1) {
      const cols = Array.from({ length: numCols }, () => []);
      const colHeights = Array(numCols).fill(0);

      // Distribuzione colonne con rispetto ordine cronologico discendente
      const itemsPerCol = Math.ceil(numChildren / numCols);
      for (let idx = 0; idx < numChildren; idx++) {
        const colIdx = Math.min(numCols - 1, Math.floor(idx / itemsPerCol));
        cols[colIdx].push(node.children[idx]);
        colHeights[colIdx] += (node.children[idx].subtreeHeight || node.children[idx].height || 40);
      }

      const activeCols = cols.filter(col => col.length > 0);
      const colWidths = activeCols.map(col => 
        col.reduce((maxW, ch) => Math.max(maxW, ch.subtreeWidth || ch.width || 200), 0)
      );
      const activeHeights = activeCols.map(col => 
        col.reduce((sumH, ch) => sumH + (ch.subtreeHeight || ch.height || 40), 0)
      );

      const maxColH = Math.max(...activeHeights);
      const totalClusterW = colWidths.reduce((sumW, w) => sumW + w, 0) + (activeCols.length - 1) * horizontalGap;

      node.subtreeHeight = Math.max(selfH + verticalGap, maxColH);
      node.subtreeWidth = (node.width || 200) + horizontalGap + totalClusterW;
      node.fannedCols = activeCols.length;
      node.colGroups = activeCols;
      node.colWidths = colWidths;
      node.colHeights = activeHeights;
      return node.subtreeHeight;
    }

    // Colonna singola
    node.subtreeHeight = Math.max(selfH + verticalGap, totalLinearH);
    const maxChildW = node.children.reduce((maxW, ch) => Math.max(maxW, ch.subtreeWidth || ch.width || 200), 0);
    node.subtreeWidth = (node.width || 200) + horizontalGap + maxChildW;
    node.fannedCols = 1;
    node.colGroups = [node.children];
    node.colWidths = [maxChildW];
    node.colHeights = [totalLinearH];
    return node.subtreeHeight;
  }

  static computeBilateralLayout(rootNode, options = {}) {
    const horizontalGap = options.horizontalGap || 48;
    const verticalGap = options.verticalGap || 12;
    const chapterGap = options.chapterGap || 20;
    const connectorStyle = options.connectorStyle || 'curved';
    const detailLevel = options.detailLevel || 'keypoints';

    if (!options.skipMeasure) MindmapEngine.measureNode(rootNode, detailLevel);
    MindmapEngine.computeSubtreeHeight(rootNode, verticalGap, horizontalGap);

    const children = rootNode.children || [];
    const rightChildren = [];
    const leftChildren = [];

    // Bilanciamento Bilaterale Sincronizzato
    const unassigned = [];
    children.forEach(c => {
      if (c.manualSide === 'left') leftChildren.push(c);
      else if (c.manualSide === 'right') rightChildren.push(c);
      else unassigned.push(c);
    });

    const mapOrder = options.mapOrder || 'chronological';

    let totalRightH = rightChildren.reduce((sum, c) => sum + (c.subtreeHeight || 0) + chapterGap, 0);
    let totalLeftH = leftChildren.reduce((sum, c) => sum + (c.subtreeHeight || 0) + chapterGap, 0);

    if (mapOrder === 'chronological') {
      // In modalità cronologica: distribuisci rigorosamente in sequenza discendente (Capitolo 1 a destra, 2 a sinistra, 3 a destra...)
      for (let i = 0; i < unassigned.length; i++) {
        const ch = unassigned[i];
        if (i % 2 === 0) {
          rightChildren.push(ch);
          totalRightH += (ch.subtreeHeight || 0) + chapterGap;
        } else {
          leftChildren.push(ch);
          totalLeftH += (ch.subtreeHeight || 0) + chapterGap;
        }
      }
    } else {
      // Modalità bilanciata greedy per altezza
      const sortedUnassigned = [...unassigned].sort((a, b) => (b.subtreeHeight || 0) - (a.subtreeHeight || 0));
      for (const ch of sortedUnassigned) {
        if (totalRightH <= totalLeftH) {
          rightChildren.push(ch);
          totalRightH += (ch.subtreeHeight || 0) + chapterGap;
        } else {
          leftChildren.push(ch);
          totalLeftH += (ch.subtreeHeight || 0) + chapterGap;
        }
      }
    }

    // Ordinamento cronologico rigoroso per ciascun lato
    const getDocOrder = (n) => (typeof n.sourceLine === 'number' ? n.sourceLine : (children.indexOf(n) >= 0 ? children.indexOf(n) : 0));
    rightChildren.sort((a, b) => getDocOrder(a) - getDocOrder(b));
    leftChildren.sort((a, b) => getDocOrder(a) - getDocOrder(b));

    // Coordinate provvisorie radice (rispetta la posizione manuale v1.9.4)
    rootNode.x = (rootNode.customX !== undefined) ? rootNode.customX : 2000;
    rootNode.y = (rootNode.customY !== undefined) ? rootNode.customY : Math.max(600, Math.max(totalRightH, totalLeftH) / 2);
    rootNode.color = '#38bdf8';
    rootNode.direction = 'center';

    const renderedNodes = [rootNode];
    const branchPaths = [];

    // Posizionamento gerarchico compatto per sottoalberi
    function placeSubtree(parent, startY, dir, color) {
      if (!parent.children || !parent.children.length || parent.layout === 'table' || parent.collapsed) return;
      let curY = startY;
      const isRight = dir === 'right';

      for (let i = 0; i < parent.children.length; i++) {
        const child = parent.children[i];
        child.color = color;
        child.direction = dir;

        if (child.customX !== undefined && child.customY !== undefined) {
          // Posizione impostata a mano (drag / frecce): rispettala
          child.x = child.customX;
          child.y = child.customY;
        } else {
          child.x = isRight ? parent.x + parent.width + horizontalGap : parent.x - child.width - horizontalGap;
          child.y = Math.round(curY + (child.subtreeHeight / 2) - (child.height / 2));

          if (i > 0) {
            const prev = parent.children[i - 1];
            const minY = prev.y + prev.height + verticalGap;
            if (child.y < minY) child.y = minY;
          }
        }

        renderedNodes.push(child);
        placeSubtree(child, child.y + (child.height / 2) - (child.subtreeHeight / 2), dir, color);
        curY = Math.max(curY + child.subtreeHeight, child.y + child.height + verticalGap);
      }
    }

    // Posizionamento Capitoli Destri
    let curRightY = rootNode.y + (rootNode.height / 2) - (totalRightH / 2);
    rightChildren.forEach((chap, idx) => {
      const color = ['#38bdf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#f472b6'][idx % 6];
      chap.color = color;
      chap.direction = 'right';
      if (chap.customX !== undefined && chap.customY !== undefined) {
        chap.x = chap.customX;
        chap.y = chap.customY;
      } else {
        chap.x = rootNode.x + rootNode.width + horizontalGap;
        chap.y = Math.round(curRightY + (chap.subtreeHeight / 2) - (chap.height / 2));

        if (idx > 0) {
          const prev = rightChildren[idx - 1];
          const minY = prev.y + prev.height + chapterGap;
          if (chap.y < minY) chap.y = minY;
        }
      }

      renderedNodes.push(chap);
      placeSubtree(chap, chap.y + (chap.height / 2) - (chap.subtreeHeight / 2), 'right', color);
      curRightY = Math.max(curRightY + chap.subtreeHeight + chapterGap, chap.y + chap.height + chapterGap);
    });

    // Posizionamento Capitoli Sinistri
    let curLeftY = rootNode.y + (rootNode.height / 2) - (totalLeftH / 2);
    leftChildren.forEach((chap, idx) => {
      const color = ['#38bdf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#f472b6'][(idx + rightChildren.length) % 6];
      chap.color = color;
      chap.direction = 'left';
      if (chap.customX !== undefined && chap.customY !== undefined) {
        chap.x = chap.customX;
        chap.y = chap.customY;
      } else {
        chap.x = rootNode.x - chap.width - horizontalGap;
        chap.y = Math.round(curLeftY + (chap.subtreeHeight / 2) - (chap.height / 2));

        if (idx > 0) {
          const prev = leftChildren[idx - 1];
          const minY = prev.y + prev.height + chapterGap;
          if (chap.y < minY) chap.y = minY;
        }
      }

      renderedNodes.push(chap);
      placeSubtree(chap, chap.y + (chap.height / 2) - (chap.subtreeHeight / 2), 'left', color);
      curLeftY = Math.max(curLeftY + chap.subtreeHeight + chapterGap, chap.y + chap.height + chapterGap);
    });

    MindmapEngine.resolveCollisions(renderedNodes, 20, 10);

    // Normalizzazione coordinate a (60, 60)
    let minX = Infinity, minY = Infinity;
    for (const n of renderedNodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
    }
    const shiftX = 60 - minX;
    const shiftY = 60 - minY;
    for (const n of renderedNodes) {
      n.x += shiftX;
      n.y += shiftY;
    }

    MindmapEngine.rebalanceSubtrees(renderedNodes, 20, 10);

    // Generazione rami di connessione
    const nodeMap = new Map();
    for (const n of renderedNodes) nodeMap.set(n.id, n);

    const connectBranch = (pNode) => {
      if (!pNode.children || !pNode.children.length || pNode.collapsed || pNode.layout === 'table') return;
      for (const ch of pNode.children) {
        if (!nodeMap.has(ch.id)) continue;
        const isRight = (ch.x + ch.width / 2) >= (pNode.x + pNode.width / 2);
        const startX = isRight ? pNode.x + pNode.width : pNode.x;
        const startYPoint = pNode.y + (pNode.height / 2);
        const targetX = isRight ? ch.x : ch.x + ch.width;
        const targetYPoint = ch.y + (ch.height / 2);

        branchPaths.push({
          d: MindmapEngine.generateBranchPath(startX, startYPoint, targetX, targetYPoint, isRight, connectorStyle),
          color: ch.color || pNode.color || '#38bdf8',
          fromId: pNode.id,
          toId: ch.id,
          edgeText: ch.edgeText || ''
        });
        connectBranch(ch);
      }
    };
    connectBranch(rootNode);

    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }

  static computeRightLayout(rootNode, options = {}) {
    const horizontalGap = options.horizontalGap || 75;
    const verticalGap = options.verticalGap || 22;
    const chapterGap = options.chapterGap || 42;
    const connectorStyle = options.connectorStyle || 'curved';
    const detailLevel = options.detailLevel || 'keypoints';

    MindmapEngine.measureNode(rootNode, detailLevel);
    MindmapEngine.computeSubtreeHeight(rootNode, verticalGap, horizontalGap);
    let totalH = 0;
    (rootNode.children || []).forEach(c => totalH += ((c.subtreeHeight || 0) + chapterGap));

    // Radice spostabile con frecce/drag (v1.9.4)
    rootNode.x = (rootNode.customX !== undefined) ? rootNode.customX : 140;
    rootNode.y = (rootNode.customY !== undefined) ? rootNode.customY : Math.max(300, totalH / 2);
    rootNode.color = '#38bdf8';
    rootNode.direction = 'right';

    const renderedNodes = [rootNode];
    const branchPaths = [];

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

        if (idx > 0) {
          const prevChap = rootNode.children[idx - 1];
          const minY = prevChap.y + prevChap.height + chapterGap;
          if (chap.y < minY) chap.y = minY;
        }
      }

      renderedNodes.push(chap);

      branchPaths.push({
        d: MindmapEngine.generateBranchPath(rootNode.x + rootNode.width, rootNode.y + (rootNode.height / 2), chap.x, chap.y + (chap.height / 2), true, connectorStyle),
        color,
        fromId: rootNode.id,
        toId: chap.id,
        edgeText: chap.edgeText || ''
      });

      MindmapEngine.positionSubChildren(chap, color, 'right', horizontalGap, renderedNodes, branchPaths, verticalGap, connectorStyle);
      curY = Math.max(curY + chap.subtreeHeight + chapterGap, chap.y + chap.height + chapterGap);
    });

    MindmapEngine.resolveCollisions(renderedNodes, 45, 34);
    MindmapEngine.rebalanceSubtrees(renderedNodes, 45, 34);
    // Rigenera i rami dalle posizioni finali (dopo la risoluzione delle collisioni).
    MindmapEngine.rebuildBranchPaths(renderedNodes, branchPaths, connectorStyle);
    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }

  static positionSubChildren(parent, color, direction, horizontalGap, renderedNodes, branchPaths, verticalGap = 12, connectorStyle = 'curved') {
    if (!parent.children || !parent.children.length || parent.layout === 'table' || parent.collapsed) return;

    const isRight = direction === 'right';
    const cols = parent.colGroups || [parent.children];
    const colWidths = parent.colWidths || [parent.children.reduce((m, c) => Math.max(m, c.width || 200), 0)];

    let currentXOffset = 0;

    for (let colIdx = 0; colIdx < cols.length; colIdx++) {
      const colChildren = cols[colIdx];
      const colW = colWidths[colIdx];
      const colTotalH = colChildren.reduce((sum, c) => sum + (c.subtreeHeight || c.height || 40), 0);

      // Centratura verticale di ciascuna colonna rispetto al genitore
      let curY = parent.y + (parent.height / 2) - (colTotalH / 2);

      const colX = isRight
        ? parent.x + parent.width + horizontalGap + currentXOffset
        : parent.x - (horizontalGap + currentXOffset + colW);

      for (const child of colChildren) {
        child.color = color;
        child.direction = direction;

        if (child.customX !== undefined && child.customY !== undefined) {
          child.x = child.customX;
          child.y = child.customY;
        } else {
          child.x = isRight ? colX : colX + (colW - child.width);
          child.y = curY + (child.subtreeHeight / 2) - (child.height / 2);
        }

        renderedNodes.push(child);

        const actualIsRight = (child.x + child.width / 2) >= (parent.x + parent.width / 2);
        const startX = actualIsRight ? parent.x + parent.width : parent.x;
        const startYPoint = parent.y + (parent.height / 2);
        const targetX = actualIsRight ? child.x : child.x + child.width;
        const targetYPoint = child.y + (child.height / 2);

        branchPaths.push({
          d: MindmapEngine.generateBranchPath(startX, startYPoint, targetX, targetYPoint, actualIsRight, connectorStyle),
          color,
          fromId: parent.id,
          toId: child.id,
          edgeText: child.edgeText || ''
        });

        curY += (child.subtreeHeight || child.height || 40);

        if (child.layout !== 'table') {
          MindmapEngine.positionSubChildren(child, color, direction, horizontalGap, renderedNodes, branchPaths, verticalGap, connectorStyle);
        }
      }

      currentXOffset += colW + horizontalGap;
    }
  }
}

// ==========================================================================
// 2. Modale Immagini Nodo
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

    // v1.8.0: Densità Contenuto ed Esportazione
    this.exportDetailLevel = this.canvas.detailLevel || 'full';
    this.textLegibility = 'optimal'; // 'optimal' (1.35x) | 'large' (1.7x) | 'compact' (1.0x)

    // Zoom & Pan Interattivo dell'Anteprima
    this.previewScale = 1;
    this.previewPanX = 0;
    this.previewPanY = 0;
    this.isPanningPreview = false;
    this.panStart = { x: 0, y: 0 };

    // Cartiglio, Logo e Testata
    this.includeTitleBlock = true;
    this.cartiglioType = 'iso'; // 'iso' | 'modern' | 'academic' | 'minimal' | 'banner'
    this.cartiglioSizePreset = 'standard'; // 'compact' | 'standard' | 'large' | 'custom'
    this.cartiglioCustomW = 360;
    this.cartiglioCustomH = 100;
    this.cartiglioPosition = 'bottom-right'; // 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

    // Dati Cartiglio & Intestazione
    this.projectName = ((this.canvas.rawRootNode || this.canvas.rootNode) && (this.canvas.rawRootNode || this.canvas.rootNode).text) ? (this.canvas.rawRootNode || this.canvas.rootNode).text : 'Mappa Concettuale';
    this.tableTitle = 'Tavola Concettuale 01';
    this.authorName = 'CDS Studio Architettura';
    this.revisionText = 'Rev. 01 · Scala 1:1';
    this.headerText = 'CDS ARCHITETTURA & DESIGN · MAPPA CONCETTUALE';
    this.stampLogo = '📐 TIMBRO CDS';

    // Logo Grafico Importato
    this.logoImageData = null; // DataURL Base64
    this.logoVaultPath = '';
    this.logoImgObj = null;
  }

  getLegibilityMultiplier() {
    switch (this.textLegibility) {
      case 'large': return 1.7;
      case 'compact': return 1.0;
      case 'optimal':
      default: return 1.35;
    }
  }

  getCartiglioDimensions(geo) {
    if (this.cartiglioType === 'banner') {
      return { w: geo.targetW, h: 95 };
    }
    const presets = {
      compact: { w: 250, h: 75 },
      standard: { w: 360, h: 100 },
      large: { w: 480, h: 130 },
      custom: { w: Math.max(180, this.cartiglioCustomW || 360), h: Math.max(60, this.cartiglioCustomH || 100) }
    };
    return presets[this.cartiglioSizePreset] || presets.standard;
  }

  getCartiglioCoordinates(boxW, boxH, totalW, totalH, margin = 24) {
    if (this.cartiglioType === 'banner') {
      return { x: 0, y: 0 };
    }
    switch (this.cartiglioPosition) {
      case 'bottom-left':
        return { x: margin, y: totalH - boxH - margin };
      case 'top-right':
        return { x: totalW - boxW - margin, y: margin };
      case 'top-left':
        return { x: margin, y: margin };
      case 'bottom-right':
      default:
        return { x: totalW - boxW - margin, y: totalH - boxH - margin };
    }
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    if (modalEl) {
      modalEl.addClass('cds-mm-export-modal-window');
      modalEl.style.width = '96vw';
      modalEl.style.maxWidth = '1450px';
      modalEl.style.height = '94vh';
      modalEl.style.maxHeight = '980px';
      modalEl.style.display = 'flex';
      modalEl.style.flexDirection = 'column';
      modalEl.style.overflow = 'hidden';
    }
    contentEl.empty();
    contentEl.addClass('cds-mm-export-modal');

    contentEl.createEl('h2', {
      text: '🎨 Esportazione Professionale (A0 - A6, Leggibilità Tipografica & Cartiglio)',
      cls: 'cds-mm-export-title'
    });

    const layoutWrap = contentEl.createDiv({ cls: 'cds-mm-export-layout' });

    // Colonna Sinistra Comandi & Personalizzazione
    const sidebar = layoutWrap.createDiv({ cls: 'cds-mm-export-sidebar' });

    // 1. SEZIONE FORMATO, LEGGIBILITÀ & DENSITÀ STAMPA
    const secDoc = sidebar.createDiv({ cls: 'cds-mm-export-section' });
    secDoc.createEl('div', { text: '📄 FORMATO & LEGGIBILITÀ STAMPA', cls: 'cds-mm-export-section-title' });

    secDoc.createEl('label', { text: 'Formato File:', cls: 'cds-mm-export-label' });
    const fmtSelect = secDoc.createEl('select', { cls: 'cds-mm-export-select' });
    [
      { val: 'png', label: 'PNG HD (Raster ad alta definizione)' },
      { val: 'svg', label: 'SVG Vettoriale (100% Ingrandibile per CAD/Illustrator)' },
      { val: 'pdf', label: 'PDF Vettoriale/Tipografico 1:1' },
      { val: 'jpg', label: 'JPG Compresso Alta Risoluzione' }
    ].forEach(f => {
      const opt = fmtSelect.createEl('option', { value: f.val, text: f.label });
      if (f.val === this.format) opt.selected = true;
    });
    fmtSelect.onchange = () => {
      this.format = fmtSelect.value;
      this.updatePreview();
    };

    secDoc.createEl('label', { text: 'Formato Carta Standard (ISO 216):', cls: 'cds-mm-export-label' });
    const paperSelect = secDoc.createEl('select', { cls: 'cds-mm-export-select' });
    Object.keys(PAPER_SIZES).forEach(k => {
      const opt = paperSelect.createEl('option', { value: k, text: PAPER_SIZES[k].label });
      if (k === this.paperSize) opt.selected = true;
    });
    paperSelect.onchange = () => {
      this.paperSize = paperSelect.value;
      this.autoAdjustOrientationNotice();
      this.updatePreview();
    };

    secDoc.createEl('label', { text: 'Orientamento Pagina:', cls: 'cds-mm-export-label' });
    const orientSelect = secDoc.createEl('select', { cls: 'cds-mm-export-select' });
    orientSelect.createEl('option', { value: 'landscape', text: '📐 Orizzontale (Landscape - Larghezza > Altezza)' });
    orientSelect.createEl('option', { value: 'portrait', text: '📏 Verticale (Portrait - Altezza > Larghezza)' });
    orientSelect.value = this.orientation;
    orientSelect.onchange = () => {
      this.orientation = orientSelect.value;
      this.updatePreview();
    };

    // Suggerimento Orientamento Automatico
    this.orientNoticeBox = secDoc.createDiv({ cls: 'cds-mm-orient-notice-box' });

    // DENSITÀ CONTENUTO PER LA STAMPA (v1.8.0)
    secDoc.createEl('label', { text: 'Densità Contenuti da Stampare:', cls: 'cds-mm-export-label' });
    const detailSelect = secDoc.createEl('select', { cls: 'cds-mm-export-select' });
    [
      { val: 'full', label: '📖 Testo Completo (Tutti i paragrafi e note)' },
      { val: 'keypoints', label: '🌟 Sintetico Poster A3/A4 (Titoli & Concetti Chiave - Max Leggibilità)' },
      { val: 'titles', label: '📑 Solo Titoli e Capitoli Principali' }
    ].forEach(d => {
      const opt = detailSelect.createEl('option', { value: d.val, text: d.label });
      if (d.val === this.exportDetailLevel) opt.selected = true;
    });
    detailSelect.onchange = () => {
      this.exportDetailLevel = detailSelect.value;
      this.autoAdjustOrientationNotice();
      this.updatePreview();
    };

    // SCALA TIPOGRAFICA / LEGGIBILITÀ (v1.8.0)
    secDoc.createEl('label', { text: 'Dimensione Testo su Carta (Leggibilità):', cls: 'cds-mm-export-label' });
    const legSelect = secDoc.createEl('select', { cls: 'cds-mm-export-select' });
    [
      { val: 'optimal', label: '🔎 Ottimizzata per Stampa (10-12pt su A3/A4 - Consigliata)' },
      { val: 'large', label: '📢 Grande da Parete / Poster Didattico (14-16pt)' },
      { val: 'compact', label: '📐 Compatta Standard (1:1)' }
    ].forEach(l => {
      const opt = legSelect.createEl('option', { value: l.val, text: l.label });
      if (l.val === this.textLegibility) opt.selected = true;
    });
    legSelect.onchange = () => {
      this.textLegibility = legSelect.value;
      this.updatePreview();
    };

    secDoc.createEl('label', { text: 'Colore Sfondo Foglio:', cls: 'cds-mm-export-label' });
    const bgSelect = secDoc.createEl('select', { cls: 'cds-mm-export-select' });
    bgSelect.createEl('option', { value: 'dark', text: 'Scuro Grafite (#0d1117)' });
    bgSelect.createEl('option', { value: 'light', text: 'Chiaro Carta Bianco (#ffffff)' });
    bgSelect.createEl('option', { value: 'transparent', text: 'Trasparente (PNG / SVG)' });
    bgSelect.value = this.bgStyle;
    bgSelect.onchange = () => {
      this.bgStyle = bgSelect.value;
      this.updatePreview();
    };

    // 2. SEZIONE CARTIGLIO, TIMBRO & LOGO
    const secCart = sidebar.createDiv({ cls: 'cds-mm-export-section' });
    secCart.createEl('div', { text: '📐 CARTIGLIO, TESTATA & LOGO GRAFICO', cls: 'cds-mm-export-section-title' });

    const blockBox = secCart.createDiv({ cls: 'cds-mm-export-cartiglio-box' });
    const blockCb = blockBox.createEl('input', { type: 'checkbox', attr: { id: 'cds-cb-cart' } });
    blockCb.checked = this.includeTitleBlock;
    blockBox.createEl('label', { text: ' Includi Cartiglio / Timbro Professionale', attr: { for: 'cds-cb-cart' } });
    blockCb.onchange = () => {
      this.includeTitleBlock = blockCb.checked;
      cartDetailsWrap.style.display = this.includeTitleBlock ? 'block' : 'none';
      this.updatePreview();
    };

    const cartDetailsWrap = secCart.createDiv({ cls: 'cds-mm-cart-details-wrap' });
    cartDetailsWrap.style.display = this.includeTitleBlock ? 'block' : 'none';

    // Tipologia Cartiglio
    cartDetailsWrap.createEl('label', { text: 'Tipologia / Formato Cartiglio:', cls: 'cds-mm-export-label' });
    const typeSelect = cartDetailsWrap.createEl('select', { cls: 'cds-mm-export-select' });
    [
      { val: 'iso', label: '📐 Tecnico UNI-EN-ISO 7200 (Griglia Squadrata)' },
      { val: 'modern', label: '🏛️ Studio Architettura & Design (Card Moderna)' },
      { val: 'academic', label: '🎓 Didattico / Universitario (Tesi/Esame)' },
      { val: 'minimal', label: '✨ Minimalista Essenziale (Badge Compatto)' },
      { val: 'banner', label: '🔝 Testata Top a Tutta Larghezza (Header Banner)' }
    ].forEach(t => {
      const opt = typeSelect.createEl('option', { value: t.val, text: t.label });
      if (t.val === this.cartiglioType) opt.selected = true;
    });
    typeSelect.onchange = () => {
      this.cartiglioType = typeSelect.value;
      customDimRow.style.display = (this.cartiglioSizePreset === 'custom' && this.cartiglioType !== 'banner') ? 'flex' : 'none';
      posGroup.style.display = (this.cartiglioType === 'banner') ? 'none' : 'block';
      this.updatePreview();
    };

    // Dimensione Preset
    cartDetailsWrap.createEl('label', { text: 'Dimensione Cartiglio:', cls: 'cds-mm-export-label' });
    const sizeSelect = cartDetailsWrap.createEl('select', { cls: 'cds-mm-export-select' });
    [
      { val: 'compact', label: 'Compatto (250 × 75 px)' },
      { val: 'standard', label: 'Standard (360 × 100 px)' },
      { val: 'large', label: 'Grande (480 × 130 px)' },
      { val: 'custom', label: 'Personalizzato (Specifica px)...' }
    ].forEach(s => {
      const opt = sizeSelect.createEl('option', { value: s.val, text: s.label });
      if (s.val === this.cartiglioSizePreset) opt.selected = true;
    });

    const customDimRow = cartDetailsWrap.createDiv({ cls: 'cds-mm-dimension-row' });
    customDimRow.style.display = (this.cartiglioSizePreset === 'custom' && this.cartiglioType !== 'banner') ? 'flex' : 'none';

    const wInp = customDimRow.createEl('input', { cls: 'cds-mm-dimension-input', type: 'number', value: this.cartiglioCustomW, attr: { placeholder: 'Larghezza px' } });
    wInp.oninput = () => {
      this.cartiglioCustomW = Math.max(150, parseInt(wInp.value, 10) || 360);
      this.updatePreview();
    };
    const hInp = customDimRow.createEl('input', { cls: 'cds-mm-dimension-input', type: 'number', value: this.cartiglioCustomH, attr: { placeholder: 'Altezza px' } });
    hInp.oninput = () => {
      this.cartiglioCustomH = Math.max(50, parseInt(hInp.value, 10) || 100);
      this.updatePreview();
    };

    sizeSelect.onchange = () => {
      this.cartiglioSizePreset = sizeSelect.value;
      customDimRow.style.display = (this.cartiglioSizePreset === 'custom' && this.cartiglioType !== 'banner') ? 'flex' : 'none';
      this.updatePreview();
    };

    // Posizione Cartiglio
    const posGroup = cartDetailsWrap.createDiv();
    posGroup.style.display = (this.cartiglioType === 'banner') ? 'none' : 'block';
    posGroup.createEl('label', { text: 'Posizione nel Foglio:', cls: 'cds-mm-export-label' });
    const posSelect = posGroup.createEl('select', { cls: 'cds-mm-export-select' });
    [
      { val: 'bottom-right', label: 'Basso a Destra (Normato)' },
      { val: 'bottom-left', label: 'Basso a Sinistra' },
      { val: 'top-right', label: 'Alto a Destra' },
      { val: 'top-left', label: 'Alto a Sinistra' }
    ].forEach(p => {
      const opt = posSelect.createEl('option', { value: p.val, text: p.label });
      if (p.val === this.cartiglioPosition) opt.selected = true;
    });
    posSelect.onchange = () => {
      this.cartiglioPosition = posSelect.value;
      this.updatePreview();
    };

    // LOGO GRAFICO (IMPORTAZIONE IMMAGINE)
    cartDetailsWrap.createEl('label', { text: 'Logo Grafico (PNG, JPG, SVG):', cls: 'cds-mm-export-label' });
    const logoRow = cartDetailsWrap.createDiv({ cls: 'cds-mm-logo-row' });

    const fileInp = logoRow.createEl('input', {
      type: 'file',
      attr: { accept: 'image/png,image/jpeg,image/svg+xml,image/webp' },
      cls: 'cds-mm-file-hidden'
    });
    fileInp.style.display = 'none';

    const btnUpload = logoRow.createEl('button', {
      cls: 'cds-mm-btn-secondary',
      text: '📁 Carica Logo dal PC...'
    });
    btnUpload.onclick = () => fileInp.click();

    fileInp.onchange = (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          this.logoImageData = ev.target.result;
          this.logoImgObj = new Image();
          this.logoImgObj.onload = () => this.updatePreview();
          this.logoImgObj.src = this.logoImageData;
          renderLogoPreview();
          this.updatePreview();
          new Notice('✅ Logo caricato: ' + file.name);
        };
        reader.readAsDataURL(file);
      }
    };

    const vaultLogoInp = cartDetailsWrap.createEl('input', {
      cls: 'cds-mm-export-input',
      attr: { placeholder: 'Oppure percorso Vault (es. Allegati/logo.png)' },
      value: this.logoVaultPath
    });
    vaultLogoInp.onchange = async () => {
      const p = vaultLogoInp.value.trim();
      this.logoVaultPath = p;
      if (p) {
        try {
          if (await this.app.vault.adapter.exists(p)) {
            const bin = await this.app.vault.adapter.readBinary(p);
            const mime = p.endsWith('.svg') ? 'image/svg+xml' : (p.endsWith('.jpg') || p.endsWith('.jpeg') ? 'image/jpeg' : 'image/png');
            let binary = '';
            const bytes = new Uint8Array(bin);
            const len = bytes.byteLength;
            for (let i = 0; i < len; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);
            this.logoImageData = 'data:' + mime + ';base64,' + base64;
            this.logoImgObj = new Image();
            this.logoImgObj.onload = () => this.updatePreview();
            this.logoImgObj.src = this.logoImageData;
            renderLogoPreview();
            this.updatePreview();
            new Notice('✅ Logo caricato dal Vault: ' + p);
          } else {
            new Notice('⚠️ File non trovato nel Vault: ' + p);
          }
        } catch (err) {
          console.warn('Vault image load error:', err);
        }
      }
    };

    const logoPreviewBox = cartDetailsWrap.createDiv({ cls: 'cds-mm-logo-preview-box' });
    const renderLogoPreview = () => {
      logoPreviewBox.empty();
      if (this.logoImageData) {
        logoPreviewBox.createEl('img', { cls: 'cds-mm-logo-thumb', attr: { src: this.logoImageData } });
        const btnRemove = logoPreviewBox.createEl('button', { cls: 'cds-mm-mini-btn cds-mm-btn-danger', text: '❌ Rimuovi' });
        btnRemove.onclick = () => {
          this.logoImageData = null;
          this.logoImgObj = null;
          vaultLogoInp.value = '';
          fileInp.value = '';
          renderLogoPreview();
          this.updatePreview();
        };
      }
    };
    renderLogoPreview();

    // Campi Testuali del Cartiglio
    cartDetailsWrap.createEl('label', { text: 'Nome Progetto / Argomento:', cls: 'cds-mm-export-label' });
    const projInp = cartDetailsWrap.createEl('input', { cls: 'cds-mm-export-input', value: this.projectName });
    projInp.oninput = () => {
      this.projectName = projInp.value.trim() || 'Mappa Concettuale';
      this.updatePreview();
    };

    cartDetailsWrap.createEl('label', { text: 'Tavola / Sottotitolo:', cls: 'cds-mm-export-label' });
    const tableInp = cartDetailsWrap.createEl('input', { cls: 'cds-mm-export-input', value: this.tableTitle });
    tableInp.oninput = () => {
      this.tableTitle = tableInp.value.trim() || 'Tavola Concettuale 01';
      this.updatePreview();
    };

    cartDetailsWrap.createEl('label', { text: 'Progettista / Autore:', cls: 'cds-mm-export-label' });
    const authorInp = cartDetailsWrap.createEl('input', { cls: 'cds-mm-export-input', value: this.authorName });
    authorInp.oninput = () => {
      this.authorName = authorInp.value.trim() || 'CDS Studio';
      this.updatePreview();
    };

    cartDetailsWrap.createEl('label', { text: 'Revisione & Scala:', cls: 'cds-mm-export-label' });
    const revInp = cartDetailsWrap.createEl('input', { cls: 'cds-mm-export-input', value: this.revisionText });
    revInp.oninput = () => {
      this.revisionText = revInp.value.trim() || 'Rev. 01 · Scala 1:1';
      this.updatePreview();
    };

    cartDetailsWrap.createEl('label', { text: 'Simbolo Alternativo (Testo / Icona):', cls: 'cds-mm-export-label' });
    const logoTxtInp = cartDetailsWrap.createEl('input', { cls: 'cds-mm-export-input', value: this.stampLogo });
    logoTxtInp.oninput = () => {
      this.stampLogo = logoTxtInp.value.trim() || '📐 TIMBRO CDS';
      this.updatePreview();
    };

    // PULSANTE AZIONE FINALE
    const bDownload = sidebar.createEl('button', {
      cls: 'cds-mm-btn-primary cds-mm-export-btn-main',
      text: '💾 Esporta e Scarica (Vault + PC)'
    });
    bDownload.onclick = () => this.doExport();

    // Colonna Destra Anteprima Ampia con Toolbar di Zoom (v1.8.0)
    const rightCol = layoutWrap.createDiv({ cls: 'cds-mm-export-right-col' });

    const previewToolbar = rightCol.createDiv({ cls: 'cds-mm-preview-toolbar' });
    const mkZoomBtn = (label, tip, onClick) => {
      const btn = previewToolbar.createEl('button', { cls: 'cds-mm-mini-btn', text: label, attr: { title: tip } });
      btn.onclick = (e) => { e.stopPropagation(); onClick(); };
      return btn;
    };

    mkZoomBtn('🔍 Adatta', 'Adatta visuale al box', () => {
      this.previewScale = 1;
      this.previewPanX = 0;
      this.previewPanY = 0;
      this.updatePreview();
    });
    mkZoomBtn('➕ Zoom In', 'Ingrandisci dettagli', () => {
      this.previewScale = Math.min(4, this.previewScale * 1.25);
      this.updatePreview();
    });
    mkZoomBtn('➖ Zoom Out', 'Riduci visuale', () => {
      this.previewScale = Math.max(0.4, this.previewScale / 1.25);
      this.updatePreview();
    });
    mkZoomBtn('1:1 Reale', 'Visuale a risoluzione 100%', () => {
      this.previewScale = 2.0;
      this.updatePreview();
    });

    this.previewBox = rightCol.createDiv({ cls: 'cds-mm-export-preview-box' });
    this.previewCanvas = this.previewBox.createEl('canvas', { cls: 'cds-mm-export-canvas-preview' });

    // Supporto Pan con mouse nell'anteprima
    this.previewBox.onmousedown = (e) => {
      this.isPanningPreview = true;
      this.panStart = { x: e.clientX - this.previewPanX, y: e.clientY - this.previewPanY };
      this.previewBox.style.cursor = 'grabbing';
    };
    window.addEventListener('mousemove', (e) => {
      if (!this.isPanningPreview) return;
      this.previewPanX = e.clientX - this.panStart.x;
      this.previewPanY = e.clientY - this.panStart.y;
      this.updatePreview();
    });
    window.addEventListener('mouseup', () => {
      this.isPanningPreview = false;
      if (this.previewBox) this.previewBox.style.cursor = 'grab';
    });
    this.previewBox.onwheel = (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1.15 : 0.88;
      this.previewScale = Math.max(0.3, Math.min(4.5, this.previewScale * delta));
      this.updatePreview();
    };

    this.autoAdjustOrientationNotice();
    this.updatePreview();
  }

  autoAdjustOrientationNotice() {
    if (!this.orientNoticeBox) return;
    this.orientNoticeBox.empty();

    const geo = this.calculateGeometry();
    const isTaller = geo.contentH > geo.contentW * 1.1;
    const isWider = geo.contentW > geo.contentH * 1.1;

    if (isTaller && this.orientation === 'landscape') {
      const bFix = this.orientNoticeBox.createEl('button', {
        cls: 'cds-mm-orient-btn',
        text: '💡 Questa mappa è sviluppata verticalmente. Clicca per impostare Verticale (Portrait) e riempire il foglio A3 senza vuoti laterali!'
      });
      bFix.onclick = () => {
        this.orientation = 'portrait';
        const sel = this.contentEl.querySelector('select[value="landscape"]');
        if (sel) sel.value = 'portrait';
        this.autoAdjustOrientationNotice();
        this.updatePreview();
      };
    } else if (isWider && this.orientation === 'portrait') {
      const bFix = this.orientNoticeBox.createEl('button', {
        cls: 'cds-mm-orient-btn',
        text: '💡 Questa mappa è estesa orizzontalmente. Clicca per impostare Orizzontale (Landscape) per massimizzare la grandezza del testo!'
      });
      bFix.onclick = () => {
        this.orientation = 'landscape';
        const sel = this.contentEl.querySelector('select[value="portrait"]');
        if (sel) sel.value = 'landscape';
        this.autoAdjustOrientationNotice();
        this.updatePreview();
      };
    }
  }

  getActiveTreeNodes() {
    const rawRoot = (this.canvas.rawRootNode || this.canvas.rootNode);
    if (!rawRoot) {
      return { nodes: this.canvas.nodes || [], paths: this.canvas.paths || [] };
    }
    // Filtra l'albero in base al livello selezionato nel modale di esportazione
    const activeTree = MindmapEngine.filterTreeByDetail(rawRoot, this.exportDetailLevel);
    const layoutOpts = { detailLevel: this.exportDetailLevel, connectorStyle: this.canvas.connectorStyle };

    let layout;
    if (this.canvas.viewMode === 'radial') {
      layout = MindmapEngine.computeRadialLayout(activeTree, layoutOpts);
    } else if (this.canvas.viewMode === 'bilateral') {
      layout = MindmapEngine.computeBilateralLayout(activeTree, layoutOpts);
    } else {
      layout = MindmapEngine.computeRightLayout(activeTree, layoutOpts);
    }
    return { nodes: layout.nodes, paths: layout.paths };
  }

  calculateGeometry() {
    const { nodes } = this.getActiveTreeNodes();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.width > maxX) maxX = n.x + n.width;
      if (n.y + n.height > maxY) maxY = n.y + n.height;
    }

    const padding = 65;
    const contentW = Math.max(200, (maxX - minX) + padding * 2);
    const contentH = Math.max(150, (maxY - minY) + padding * 2);

    if (this.paperSize === 'Auto' || !PAPER_SIZES[this.paperSize]) {
      return { targetW: contentW, targetH: contentH, minX, minY, maxX, maxY, contentW, contentH };
    }

    const p = PAPER_SIZES[this.paperSize];
    const baseMin = Math.min(p.w, p.h);
    const baseMax = Math.max(p.w, p.h);

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

  computeSafeCanvasSize(targetW, targetH, requestedDpi) {
    const MAX_DIM = 7680;
    const MAX_PIXELS = 36000000;
    let finalDpi = requestedDpi;
    let rawW = Math.round(targetW * finalDpi);
    let rawH = Math.round(targetH * finalDpi);

    if (rawW > MAX_DIM || rawH > MAX_DIM || (rawW * rawH) > MAX_PIXELS) {
      const scaleDim = Math.min(MAX_DIM / targetW, MAX_DIM / targetH);
      const scalePixels = Math.sqrt(MAX_PIXELS / (targetW * targetH));
      finalDpi = Math.max(1, Math.min(finalDpi, Math.min(scaleDim, scalePixels) * 0.995));
      rawW = Math.floor(targetW * finalDpi);
      rawH = Math.floor(targetH * finalDpi);
    }
    return { w: rawW, h: rawH, dpi: finalDpi };
  }

  drawNodeOnExportCanvas(ctx, n, bgStyle, isPreview = false, scale = 1) {
    const legMult = this.getLegibilityMultiplier();
    const isLight = bgStyle === 'light';
    const cardBg = n.isRoot 
      ? '#2563eb' 
      : (isLight ? '#f8fafc' : '#1a2238');
    const borderColor = n.customColor || (n.isRoot ? '#60a5fa' : n.color || '#38bdf8');
    const textColor = n.isRoot ? '#ffffff' : (isLight ? '#0f172a' : '#f8fafc');
    const bodyColor = isLight ? '#334155' : '#cbd5e1';

    ctx.fillStyle = cardBg;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = isPreview ? Math.max(1.2, 1.8 * scale) : 2.4;

    ctx.beginPath();
    ctx.roundRect(n.x, n.y, n.width, n.height, isPreview ? 5 : 8);
    ctx.fill();
    ctx.stroke();

    // 1. Disegna Titolo Nodo con dimensione tipografica ottimizzata
    const titleFontSize = Math.round((n.isRoot ? 17 : 13.5) * legMult);
    ctx.fillStyle = textColor;
    ctx.font = `bold ${titleFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = 'top';

    const paddingX = Math.round(12 * legMult);
    const maxTextW = n.width - (paddingX * 2);
    let curY = n.y + Math.round(10 * legMult);

    const titleWords = (n.text || '').split(' ');
    let currentLine = '';
    const lineH = Math.round(titleFontSize * 1.3);

    for (let wIdx = 0; wIdx < titleWords.length; wIdx++) {
      const testLine = currentLine + (currentLine ? ' ' : '') + titleWords[wIdx];
      if (ctx.measureText(testLine).width > maxTextW && currentLine) {
        ctx.fillText(currentLine, n.x + paddingX, curY);
        currentLine = titleWords[wIdx];
        curY += lineH;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      ctx.fillText(currentLine, n.x + paddingX, curY);
      curY += lineH;
    }

    // 2. Disegna Testo Completo Corpo (se attivo)
    const hasFull = (this.exportDetailLevel === 'full' || n.isExpanded) && n.bodyText && n.bodyText.trim();
    if (hasFull) {
      curY += 4;
      ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(n.x + paddingX, curY);
      ctx.lineTo(n.x + n.width - paddingX, curY);
      ctx.stroke();
      curY += 6;

      const bodyFontSize = Math.round(11.5 * legMult);
      const bodyLineH = Math.round(bodyFontSize * 1.32);
      ctx.fillStyle = bodyColor;
      ctx.font = `${bodyFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

      const paragraphs = n.bodyText.split('\n');
      for (const para of paragraphs) {
        const pTrimmed = para.trim();
        if (!pTrimmed) {
          curY += 6;
          continue;
        }
        const words = pTrimmed.split(' ');
        let pLine = '';
        for (let i = 0; i < words.length; i++) {
          const test = pLine + (pLine ? ' ' : '') + words[i];
          if (ctx.measureText(test).width > maxTextW && pLine) {
            ctx.fillText(pLine, n.x + paddingX, curY);
            pLine = words[i];
            curY += bodyLineH;
            if (curY > n.y + n.height - 20) break;
          } else {
            pLine = test;
          }
        }
        if (pLine && curY <= n.y + n.height - 16) {
          ctx.fillText(pLine, n.x + paddingX, curY);
          curY += bodyLineH;
        }
        if (curY > n.y + n.height - 20) break;
      }
    }

    if (n.pdfLink) {
      const badgeY = n.y + n.height - 24;
      ctx.fillStyle = 'rgba(239, 68, 68, 0.18)';
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(n.x + paddingX, badgeY, n.width - (paddingX * 2), 18, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = isLight ? '#b91c1c' : '#fca5a5';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(`📄 ${n.pdfLink.file} · Pag. ${n.pdfLink.page}`, n.x + paddingX + 6, badgeY + 3);
    }
  }

  drawTitleBlockOnCanvas(ctx, totalW, totalH, scale = 1) {
    if (!this.includeTitleBlock) return;

    const s = scale || 1;
    const isLight = this.bgStyle === 'light';
    const geo = { targetW: totalW / s, targetH: totalH / s };
    const dim = this.getCartiglioDimensions(geo);
    const coords = this.getCartiglioCoordinates(dim.w, dim.h, geo.targetW, geo.targetH, 24);

    const bx = coords.x * s;
    const by = coords.y * s;
    const bw = dim.w * s;
    const bh = dim.h * s;
    const isBanner = this.cartiglioType === 'banner';

    ctx.save();
    ctx.fillStyle = isLight ? '#f1f5f9' : '#161b2e';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = Math.max(1, 1.8 * s);

    if (isBanner) {
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
    } else {
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 8 * s);
      ctx.fill();
      ctx.stroke();
    }

    let textOffsetX = bx + 16 * s;

    if (this.logoImgObj && this.logoImgObj.complete && this.logoImgObj.naturalWidth > 0) {
      const logoSize = Math.min(bh - 18 * s, 64 * s);
      const logoX = bx + 14 * s;
      const logoY = by + (bh - logoSize) / 2;
      try {
        ctx.drawImage(this.logoImgObj, logoX, logoY, logoSize, logoSize);
        textOffsetX = logoX + logoSize + 14 * s;
      } catch (err) {
        console.warn('Canvas draw logo error:', err);
      }
    }

    if (this.cartiglioType === 'iso') {
      const colX = Math.max(textOffsetX + 4 * s, bx + bw * 0.28);
      ctx.beginPath();
      ctx.moveTo(colX, by);
      ctx.lineTo(colX, by + bh);
      ctx.moveTo(colX, by + bh * 0.5);
      ctx.lineTo(bx + bw, by + bh * 0.5);
      ctx.stroke();

      if (!this.logoImgObj) {
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold ' + Math.max(8, Math.round(11 * s)) + 'px sans-serif';
        ctx.fillText(this.stampLogo, bx + 12 * s, by + bh * 0.45);
      }

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold ' + Math.max(7, Math.round(9.5 * s)) + 'px sans-serif';
      ctx.fillText(`STUDIO / ENTE: ${this.authorName.toUpperCase()}`, colX + 10 * s, by + 16 * s);

      ctx.fillStyle = isLight ? '#0f172a' : '#ffffff';
      ctx.font = 'bold ' + Math.max(8, Math.round(11 * s)) + 'px sans-serif';
      ctx.fillText(`PROGETTO: ${this.projectName.slice(0, 32)}`, colX + 10 * s, by + 34 * s);

      ctx.fillStyle = '#94a3b8';
      ctx.font = Math.max(7, Math.round(9 * s)) + 'px sans-serif';
      ctx.fillText(`TAVOLA: ${this.tableTitle}`, colX + 10 * s, by + bh * 0.5 + 18 * s);
      ctx.fillText(this.revisionText, bx + bw - (130 * s), by + bh * 0.5 + 18 * s);

    } else if (this.cartiglioType === 'modern') {
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold ' + Math.max(9, Math.round(12 * s)) + 'px sans-serif';
      ctx.fillText(this.stampLogo, textOffsetX, by + 22 * s);

      ctx.fillStyle = isLight ? '#0f172a' : '#ffffff';
      ctx.font = 'bold ' + Math.max(9, Math.round(11.5 * s)) + 'px sans-serif';
      ctx.fillText(this.projectName.slice(0, 34), textOffsetX, by + 44 * s);

      ctx.fillStyle = '#94a3b8';
      ctx.font = Math.max(7, Math.round(9 * s)) + 'px sans-serif';
      ctx.fillText(`${this.authorName} · ${this.tableTitle} · ${this.revisionText}`, textOffsetX, by + 66 * s);

    } else if (this.cartiglioType === 'academic') {
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold ' + Math.max(8, Math.round(10 * s)) + 'px sans-serif';
      ctx.fillText('UNIVERSITÀ DEGLI STUDI · CORSO DI LAUREA', textOffsetX, by + 18 * s);

      ctx.fillStyle = isLight ? '#0f172a' : '#ffffff';
      ctx.font = 'bold ' + Math.max(9, Math.round(12 * s)) + 'px sans-serif';
      ctx.fillText(this.projectName.slice(0, 34), textOffsetX, by + 38 * s);

      ctx.fillStyle = '#94a3b8';
      ctx.font = Math.max(7, Math.round(9 * s)) + 'px sans-serif';
      ctx.fillText(`Candidato: ${this.authorName} · ${this.tableTitle} · A.A. 2026/2027`, textOffsetX, by + 60 * s);

    } else if (this.cartiglioType === 'minimal') {
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold ' + Math.max(8, Math.round(10 * s)) + 'px sans-serif';
      ctx.fillText(this.stampLogo, textOffsetX, by + 24 * s);

      ctx.fillStyle = isLight ? '#0f172a' : '#ffffff';
      ctx.font = Math.max(8, Math.round(10 * s)) + 'px sans-serif';
      ctx.fillText(`${this.projectName.slice(0, 24)} · ${this.authorName} · ${this.revisionText}`, textOffsetX, by + 46 * s);

    } else if (this.cartiglioType === 'banner') {
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold ' + Math.max(10, Math.round(14 * s)) + 'px sans-serif';
      ctx.fillText(this.headerText, textOffsetX, by + 32 * s);

      ctx.fillStyle = isLight ? '#0f172a' : '#ffffff';
      ctx.font = Math.max(9, Math.round(11 * s)) + 'px sans-serif';
      ctx.fillText(`${this.projectName} · ${this.tableTitle}`, textOffsetX, by + 56 * s);

      ctx.fillStyle = '#94a3b8';
      ctx.font = Math.max(8, Math.round(10 * s)) + 'px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${this.authorName} · ${this.paperSize} ${this.orientation} · ${this.revisionText}`, bw - 24 * s, by + 44 * s);
      ctx.textAlign = 'left';
    }

    ctx.restore();
  }

  updatePreview() {
    const geo = this.calculateGeometry();
    const { nodes, paths } = this.getActiveTreeNodes();

    const pCanvas = this.previewCanvas;
    const boxW = (this.previewBox && this.previewBox.clientWidth) ? Math.max(360, this.previewBox.clientWidth - 40) : 720;
    const boxH = (this.previewBox && this.previewBox.clientHeight) ? Math.max(300, this.previewBox.clientHeight - 40) : 600;
    const scaleW = boxW / geo.targetW;
    const scaleH = boxH / geo.targetH;
    const baseScale = Math.min(scaleW, scaleH);
    const scale = baseScale * this.previewScale;

    pCanvas.width = Math.round(geo.targetW * baseScale);
    pCanvas.height = Math.round(geo.targetH * baseScale);

    const ctx = pCanvas.getContext('2d');
    ctx.clearRect(0, 0, pCanvas.width, pCanvas.height);

    if (this.bgStyle === 'light') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pCanvas.width, pCanvas.height);
    } else if (this.bgStyle === 'dark') {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, pCanvas.width, pCanvas.height);
    }

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, pCanvas.width - 4, pCanvas.height - 4);

    const offsetX = (geo.targetW - geo.contentW) / 2 + 65 - geo.minX;
    const offsetY = (geo.targetH - geo.contentH) / 2 + 65 - geo.minY;

    ctx.save();
    ctx.translate(this.previewPanX, this.previewPanY);
    ctx.scale(scale, scale);
    ctx.translate(offsetX, offsetY);

    for (const p of paths || []) {
      ctx.strokeStyle = p.color || '#38bdf8';
      ctx.lineWidth = 2.8;
      const path2d = new Path2D(p.d);
      ctx.stroke(path2d);
    }

    for (const n of nodes || []) {
      this.drawNodeOnExportCanvas(ctx, n, this.bgStyle, true, scale);
    }

    ctx.restore();

    if (this.includeTitleBlock) {
      this.drawTitleBlockOnCanvas(ctx, pCanvas.width, pCanvas.height, baseScale);
    }
  }

  async doExport() {
    const title = (this.projectName || 'mindmap').replace(/[/\\?%*:|"<>]/g, '_');
    const ext = this.format;
    const fileName = `${title}_${this.paperSize}_${this.orientation}.${ext}`;
    const geo = this.calculateGeometry();
    const { nodes, paths } = this.getActiveTreeNodes();

    // 1. ESPORTAZIONE VETTORIALE SVG (Zero perdita di qualità, CAD / Illustrator compatibile)
    if (this.format === 'svg') {
      const svgContent = this.generateCompleteVectorSVG(geo, nodes, paths);

      try {
        const exportFolder = 'Mappe Esportate';
        if (!(await this.app.vault.adapter.exists(exportFolder))) {
          await this.app.vault.createFolder(exportFolder);
        }
        const vaultPath = `${exportFolder}/${fileName}`;
        await this.app.vault.adapter.write(vaultPath, svgContent);
      } catch (err) {
        console.warn('[EXPORT SVG] Vault write error:', err);
      }

      try {
        const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          try { document.body.removeChild(a); } catch (e) {}
          URL.revokeObjectURL(url);
        }, 3000);
      } catch (err) {
        console.warn('[EXPORT SVG] Download error:', err);
      }

      new Notice('✅ Mappa SVG vettoriale salvata in "Mappe Esportate" e scaricata!', 6000);
      this.close();
      return;
    }

    // 2. ESPORTAZIONE RASTER HD (PNG, JPG, PDF) CON SAFE SIZING ANTI-CRASH
    const dpiMap = { A6: 4, A5: 3.8, A4: 3.2, A3: 2.8, A2: 2.2, A1: 1.8, A0: 1.5, Auto: 2.5 };
    const requestedDpi = dpiMap[this.paperSize] || this.qualityDpi || 2.5;
    const safeDim = this.computeSafeCanvasSize(geo.targetW, geo.targetH, requestedDpi);

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = safeDim.w;
    exportCanvas.height = safeDim.h;

    const ctx = exportCanvas.getContext('2d');
    ctx.scale(safeDim.dpi, safeDim.dpi);

    if (this.bgStyle === 'light') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, geo.targetW, geo.targetH);
    } else if (this.bgStyle === 'dark') {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, geo.targetW, geo.targetH);
    }

    const offsetX = (geo.targetW - geo.contentW) / 2 + 65 - geo.minX;
    const offsetY = (geo.targetH - geo.contentH) / 2 + 65 - geo.minY;

    ctx.save();
    ctx.translate(offsetX, offsetY);

    for (const p of paths || []) {
      ctx.strokeStyle = p.color || '#38bdf8';
      ctx.lineWidth = 2.8;
      const path2d = new Path2D(p.d);
      ctx.stroke(path2d);
    }

    for (const n of nodes || []) {
      this.drawNodeOnExportCanvas(ctx, n, this.bgStyle, false, 1);
    }

    ctx.restore();

    if (this.includeTitleBlock) {
      this.drawTitleBlockOnCanvas(ctx, exportCanvas.width, exportCanvas.height, safeDim.dpi);
    }

    if (this.format === 'pdf') {
      const dataUrl = exportCanvas.toDataURL('image/jpeg', 0.95);

      try {
        const arrayBuffer = await (await fetch(dataUrl)).arrayBuffer();
        const exportFolder = 'Mappe Esportate';
        if (!(await this.app.vault.adapter.exists(exportFolder))) {
          await this.app.vault.createFolder(exportFolder);
        }
        await this.app.vault.adapter.writeBinary(`${exportFolder}/${title}_${this.paperSize}_HD.jpg`, arrayBuffer);
      } catch (err) {
        console.warn('[EXPORT PDF] Vault write error:', err);
      }

      let iframe = document.getElementById('cds-mm-print-frame');
      if (iframe) iframe.remove();
      iframe = document.createElement('iframe');
      iframe.id = 'cds-mm-print-frame';
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      document.body.appendChild(iframe);

      const printDoc = iframe.contentWindow.document;
      printDoc.open();
      printDoc.write(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>${title} - ${this.paperSize}</title>
            <style>
              @page { size: ${this.paperSize === 'Auto' ? 'auto' : this.paperSize} ${this.orientation}; margin: 0; }
              body { margin: 0; padding: 0; background: ${this.bgStyle === 'light' ? '#ffffff' : '#0d1117'}; }
              .page { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; }
              img { max-width: 100%; max-height: 100%; object-fit: contain; }
            </style>
          </head>
          <body>
            <div class="page"><img src="${dataUrl}" /></div>
          </body>
        </html>
      `);
      printDoc.close();

      setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setTimeout(() => {
          try { iframe.remove(); } catch (e) {}
        }, 60000);
      }, 400);

      new Notice('📄 Finestra di stampa PDF avviata! Copia HD salvata in "Mappe Esportate".', 6000);
      this.close();
      return;
    }

    // 3. PNG & JPG: SALVATAGGIO CON FALLBACK DOPPIO
    const mime = this.format === 'jpg' ? 'image/jpeg' : 'image/png';

    const saveAndDownloadBlob = async (blob) => {
      if (!blob) {
        try {
          const dataUrl = exportCanvas.toDataURL(mime, 0.92);
          const parts = dataUrl.split(',');
          const bstr = atob(parts[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) u8arr[n] = bstr.charCodeAt(n);
          blob = new Blob([u8arr], { type: mime });
        } catch (e) {
          console.error('DataURL fallback error:', e);
        }
      }

      if (!blob) {
        new Notice("❌ Impossibile generare l'immagine con questa risoluzione di sistema. Si consiglia l'esportazione in SVG Vettoriale o la riduzione del formato.", 8000);
        return;
      }

      try {
        const arrayBuffer = await blob.arrayBuffer();
        const exportFolder = 'Mappe Esportate';
        if (!(await this.app.vault.adapter.exists(exportFolder))) {
          await this.app.vault.createFolder(exportFolder);
        }
        const vaultPath = `${exportFolder}/${fileName}`;
        await this.app.vault.adapter.writeBinary(vaultPath, arrayBuffer);
      } catch (err) {
        console.warn('[EXPORT] Vault save error:', err);
      }

      try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          try { document.body.removeChild(a); } catch (e) {}
          URL.revokeObjectURL(url);
        }, 3000);
      } catch (err) {
        console.warn('[EXPORT] Download error:', err);
      }

      new Notice(`✅ Mappa ${this.format.toUpperCase()} salvata in "Mappe Esportate" e scaricata su PC!`, 6000);
    };

    try {
      exportCanvas.toBlob(saveAndDownloadBlob, mime, 0.95);
    } catch (err) {
      console.warn('toBlob exception, attempting direct dataUrl fallback:', err);
      await saveAndDownloadBlob(null);
    }

    this.close();
  }

  generateCompleteVectorSVG(geo, nodes, paths) {
    if (!geo || !nodes || !paths) {
      geo = this.calculateGeometry();
      const treeData = this.getActiveTreeNodes();
      nodes = nodes || treeData.nodes;
      paths = paths || treeData.paths;
    }
    const legMult = this.getLegibilityMultiplier();
    const bg = this.bgStyle === 'light' ? '#ffffff' : (this.bgStyle === 'transparent' ? 'none' : '#0d1117');
    const textFill = this.bgStyle === 'light' ? '#0f172a' : '#ffffff';
    const bodyFill = this.bgStyle === 'light' ? '#334155' : '#cbd5e1';
    const offsetX = (geo.targetW - geo.contentW) / 2 + 65 - geo.minX;
    const offsetY = (geo.targetH - geo.contentH) / 2 + 65 - geo.minY;

    const titleFontSize = Math.round(13.5 * legMult);
    const bodyFontSize = Math.round(11.5 * legMult);

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(geo.targetW)}" height="${Math.round(geo.targetH)}" viewBox="0 0 ${Math.round(geo.targetW)} ${Math.round(geo.targetH)}">
<defs>
  <style>
    .node-title { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: ${titleFontSize}px; font-weight: bold; fill: ${textFill}; }
    .root-title { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: ${Math.round(17 * legMult)}px; font-weight: bold; fill: #ffffff; }
    .node-body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: ${bodyFontSize}px; fill: ${bodyFill}; }
    .branch-line { fill: none; stroke-linecap: round; stroke-width: 2.8px; }
  </style>
</defs>
`;

    if (bg !== 'none') {
      svg += `<rect width="100%" height="100%" fill="${bg}"/>\n`;
    }

    svg += `<g transform="translate(${offsetX}, ${offsetY})">\n`;

    for (const p of paths || []) {
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

    for (const n of nodes || []) {
      const fill = n.isRoot ? '#2563eb' : (this.bgStyle === 'light' ? '#f8fafc' : '#1a2238');
      const stroke = n.customColor || (n.isRoot ? '#60a5fa' : n.color || '#38bdf8');

      svg += `  <g class="node-card">
    <rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
`;

      const maxChar = Math.max(16, Math.floor((n.width - 24) / (7.5 * legMult)));
      const titleLines = [];
      const words = (n.text || '').split(' ');
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).length > maxChar && cur) {
          titleLines.push(cur);
          cur = w;
        } else {
          cur = cur ? cur + ' ' + w : w;
        }
      }
      if (cur) titleLines.push(cur);

      let tY = n.y + Math.round(18 * legMult);
      const dyStep = Math.round(titleFontSize * 1.25);
      svg += `    <text x="${n.x + 12}" y="${tY}" class="${n.isRoot ? 'root-title' : 'node-title'}">\n`;
      titleLines.forEach((tl, i) => {
        const cleanTl = tl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        svg += `      <tspan x="${n.x + 12}" dy="${i === 0 ? 0 : dyStep}">${cleanTl}</tspan>\n`;
        tY += dyStep;
      });
      svg += `    </text>\n`;

      const hasFull = (this.exportDetailLevel === 'full' || n.isExpanded) && n.bodyText && n.bodyText.trim();
      if (hasFull) {
        tY += 4;
        svg += `    <line x1="${n.x + 10}" y1="${tY}" x2="${n.x + n.width - 10}" y2="${tY}" stroke="${this.bgStyle === 'light' ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)'}" stroke-width="1"/>\n`;
        tY += 14;

        const bodyLines = [];
        const bodyMaxChar = Math.max(20, Math.floor((n.width - 24) / (6.4 * legMult)));
        for (const p of n.bodyText.split('\n')) {
          const pWords = p.trim().split(' ');
          let bCur = '';
          for (const pw of pWords) {
            if ((bCur + ' ' + pw).length > bodyMaxChar && bCur) {
              bodyLines.push(bCur);
              bCur = pw;
            } else {
              bCur = bCur ? bCur + ' ' + pw : pw;
            }
          }
          if (bCur) bodyLines.push(bCur);
        }

        const bodyDyStep = Math.round(bodyFontSize * 1.3);
        svg += `    <text x="${n.x + 12}" y="${tY}" class="node-body">\n`;
        bodyLines.forEach((bl, i) => {
          if (tY + i * bodyDyStep < n.y + n.height - 10) {
            const cleanBl = bl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            svg += `      <tspan x="${n.x + 12}" dy="${i === 0 ? 0 : bodyDyStep}">${cleanBl}</tspan>\n`;
          }
        });
        svg += `    </text>\n`;
      }

      svg += `  </g>\n`;
    }

    svg += `</g>\n`;

    // Cartiglio Vettoriale SVG
    if (this.includeTitleBlock) {
      const dim = this.getCartiglioDimensions(geo);
      const coords = this.getCartiglioCoordinates(dim.w, dim.h, geo.targetW, geo.targetH, 24);
      const bx = coords.x, by = coords.y, bw = dim.w, bh = dim.h;
      const isBanner = this.cartiglioType === 'banner';
      const cFill = this.bgStyle === 'light' ? '#f1f5f9' : '#161b2e';
      const cleanProj = this.projectName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const cleanAuthor = this.authorName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const cleanTable = this.tableTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const cleanRev = this.revisionText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const cleanLogo = this.stampLogo.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      svg += `<g class="cartiglio" transform="translate(${bx}, ${by})">\n`;
      svg += `  <rect width="${bw}" height="${bh}" rx="${isBanner ? 0 : 8}" fill="${cFill}" stroke="#38bdf8" stroke-width="2"/>\n`;

      let textOffX = 18;
      if (this.logoImageData) {
        const logoSz = Math.min(bh - 18, 64);
        const logoY = (bh - logoSz) / 2;
        svg += `  <image href="${this.logoImageData}" x="14" y="${logoY}" width="${logoSz}" height="${logoSz}" preserveAspectRatio="xMidYMid meet"/>\n`;
        textOffX = 14 + logoSz + 14;
      }

      if (this.cartiglioType === 'iso') {
        const colX = Math.max(textOffX + 4, bw * 0.28);
        svg += `  <line x1="${colX}" y1="0" x2="${colX}" y2="${bh}" stroke="#38bdf8" stroke-width="1.2"/>\n`;
        svg += `  <line x1="${colX}" y1="${bh * 0.5}" x2="${bw}" y2="${bh * 0.5}" stroke="#38bdf8" stroke-width="1.2"/>\n`;
        if (!this.logoImageData) {
          svg += `  <text x="14" y="${bh * 0.5 + 4}" font-family="sans-serif" font-size="12" font-weight="bold" fill="#38bdf8">${cleanLogo}</text>\n`;
        }
        svg += `  <text x="${colX + 12}" y="18" font-family="sans-serif" font-size="10" font-weight="bold" fill="#38bdf8">STUDIO / ENTE: ${cleanAuthor.toUpperCase()}</text>\n`;
        svg += `  <text x="${colX + 12}" y="38" font-family="sans-serif" font-size="13" font-weight="bold" fill="${textFill}">PROGETTO: ${cleanProj.slice(0, 36)}</text>\n`;
        svg += `  <text x="${colX + 12}" y="${bh * 0.5 + 24}" font-family="sans-serif" font-size="11" fill="#94a3b8">TAVOLA: ${cleanTable}</text>\n`;
        svg += `  <text x="${bw - 150}" y="${bh * 0.5 + 24}" font-family="sans-serif" font-size="11" fill="#94a3b8">${cleanRev}</text>\n`;
      } else if (this.cartiglioType === 'modern') {
        svg += `  <text x="${textOffX}" y="28" font-family="sans-serif" font-size="14" font-weight="bold" fill="#38bdf8">${cleanLogo}</text>\n`;
        svg += `  <text x="${textOffX}" y="52" font-family="sans-serif" font-size="13" font-weight="600" fill="${textFill}">${cleanProj.slice(0, 36)}</text>\n`;
        svg += `  <text x="${textOffX}" y="76" font-family="sans-serif" font-size="11" fill="#94a3b8">${cleanAuthor} · ${cleanTable} · ${cleanRev}</text>\n`;
      } else if (this.cartiglioType === 'academic') {
        svg += `  <text x="${textOffX}" y="22" font-family="sans-serif" font-size="11" font-weight="bold" fill="#38bdf8">UNIVERSITÀ DEGLI STUDI · CORSO DI LAUREA</text>\n`;
        svg += `  <text x="${textOffX}" y="44" font-family="sans-serif" font-size="13" font-weight="600" fill="${textFill}">${cleanProj.slice(0, 36)}</text>\n`;
        svg += `  <text x="${textOffX}" y="68" font-family="sans-serif" font-size="11" fill="#94a3b8">Candidato: ${cleanAuthor} · ${cleanTable} · A.A. 2026/2027</text>\n`;
      } else if (this.cartiglioType === 'minimal') {
        svg += `  <text x="${textOffX}" y="28" font-family="sans-serif" font-size="12" font-weight="bold" fill="#38bdf8">${cleanLogo}</text>\n`;
        svg += `  <text x="${textOffX}" y="50" font-family="sans-serif" font-size="11" fill="${textFill}">${cleanProj.slice(0, 24)} · ${cleanAuthor} · ${cleanRev}</text>\n`;
      } else if (this.cartiglioType === 'banner') {
        svg += `  <text x="${textOffX}" y="36" font-family="sans-serif" font-size="16" font-weight="bold" fill="#38bdf8">${this.headerText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text>\n`;
        svg += `  <text x="${textOffX}" y="62" font-family="sans-serif" font-size="13" fill="${textFill}">${cleanProj} · ${cleanTable}</text>\n`;
        svg += `  <text x="${bw - 24}" y="50" font-family="sans-serif" font-size="12" fill="#94a3b8" text-anchor="end">${cleanAuthor} · ${cleanRev}</text>\n`;
      }

      svg += `</g>\n`;
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
    this.viewMode = options.viewMode || 'bilateral';
    this.mapOrder = options.mapOrder || 'chronological';
    this.detailLevel = options.detailLevel || 'keypoints';

    // v1.8.0: Stile connettori, ripasso attivo e breadcrumb glow
    this.connectorStyle = options.connectorStyle || 'curved';
    this.theme = options.theme || (this.plugin && this.plugin.settings && this.plugin.settings.theme) || 'dark';
    this.isDockCollapsed = false;
    this.isStudyMode = false;
    this.revealedNodes = new Set();
    this.hoveredNodeId = null;

    // v1.8.0: Densità spaziatura, Selezione Multipla e Gruppi Canvas
    this.spacingDensity = options.spacingDensity || 'compact'; // 'compact' | 'ultra-compact' | 'standard'
    this.selectedNodeIds = new Set();
    this.groups = [];
    this.isMarquee = false;
    this.marqueeStart = null;
    this.draggedGroupState = null;

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

    // v1.9.5: Cronologia spostamenti per Ctrl+Z (frecce, drag col mouse, gruppi).
    // Persistita su disco (fileLayouts) per sopravvivere al riavvio di Obsidian.
    this.moveHistory = [];
    this.moveHistoryLimit = 60;

    // RIPRISTINA MEMORIA LAYOUT SALVATA SU DISCO (DATA.JSON) PER QUESTO FILE
    if (this.plugin && this.plugin.settings && this.plugin.settings.fileLayouts && this.filePath) {
      const saved = this.plugin.settings.fileLayouts[this.filePath];
      if (saved) {
        if (saved.spacingDensity) this.spacingDensity = saved.spacingDensity;
        if (saved.groups && Array.isArray(saved.groups)) this.groups = saved.groups;
        this.applySavedLayout(saved);
        // Cronologia undo ripristinata (ultimi N snapshot; le posizioni dei nodi
        // vengono riapplicate da undoMove via findRawNode per id deterministico)
        if (Array.isArray(saved.moveHistory)) {
          this.moveHistory = saved.moveHistory.slice(-this.moveHistoryLimit);
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

    // Layer Gruppi Canvas (v1.8.0)
    this.groupsLayer = this.stage.createDiv({ cls: 'cds-mm-groups-layer' });

    this.svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svgLayer.setAttribute('class', 'cds-mm-svg');
    this.stage.appendChild(this.svgLayer);

    // Layer Controlli Tratti / Bottoni + sul ramo (v1.8.0)
    this.edgesControlsLayer = this.stage.createDiv({ cls: 'cds-mm-edges-layer' });

    this.nodesLayer = this.stage.createDiv({ cls: 'cds-mm-nodes-layer' });

    // Floating Bar contestuale sul nodo selezionato
    this.floatingBar = this.stage.createDiv({ cls: 'cds-mm-floating-bar' });
    this.floatingBar.style.display = 'none';

    // Floating Toolbar Selezione Multipla (v1.8.0)
    this.multiSelectToolbar = this.container.createDiv({ cls: 'cds-mm-multi-toolbar' });
    this.multiSelectToolbar.style.display = 'none';

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
    this.applyTheme();

    // Se l'utente ha collassato la barra per visuale libera, mostra solo pillola compatta
    if (this.isDockCollapsed) {
      const pillToggle = this.topDock.createEl('button', {
        cls: 'cds-mm-dock-toggle-btn',
        attr: { title: 'Espandi barra degli strumenti' }
      });
      pillToggle.innerHTML = '🗺️ <span class="cds-mm-btn-text">Strumenti Mappa</span> ▾';
      pillToggle.onmousedown = (e) => e.stopPropagation();
      pillToggle.onclick = (e) => {
        e.stopPropagation();
        this.isDockCollapsed = false;
        this.renderTopDock();
      };
      return;
    }

    // Toggle Collasso Barra
    const btnCollapse = this.topDock.createEl('button', {
      cls: 'cds-mm-dock-toggle-btn',
      attr: { title: 'Comprimi barra per visuale libera' }
    });
    btnCollapse.innerHTML = '−';
    btnCollapse.style.cssText = 'padding:3px 8px;font-weight:900;';
    btnCollapse.onmousedown = (e) => e.stopPropagation();
    btnCollapse.onclick = (e) => {
      e.stopPropagation();
      this.isDockCollapsed = true;
      this.renderTopDock();
    };

    // GRUPPO 1: VISTE MULTIPLE & TEMI
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

    mkViewBtn('radial', 'Radiale', '🌟');
    mkViewBtn('bilateral', 'Bilaterale', '🧠');
    mkViewBtn('right', 'A Destra', '🌿');
    mkViewBtn('table', 'Tabella', '📊');
    mkViewBtn('outline', 'Outline', '📑');

    // Selettore Temi Visivi Architetturali (v1.8.0)
    const themeLabels = { dark: 'Scuro', blueprint: 'CAD Blueprint', light: 'Carta' };
    const btnTheme = groupViews.createEl('button', {
      cls: 'cds-mm-dock-btn',
      attr: { title: 'Cambia Tema: Scuro Studio, CAD Blueprint o Carta Editoriale' }
    });
    btnTheme.innerHTML = `🎨 <span class="cds-mm-btn-text">${themeLabels[this.theme] || 'Tema'}</span>`;
    btnTheme.onmousedown = (e) => e.stopPropagation();
    btnTheme.onclick = (e) => {
      e.stopPropagation();
      const themes = ['dark', 'blueprint', 'light'];
      const nextIdx = (themes.indexOf(this.theme) + 1) % themes.length;
      this.theme = themes[nextIdx];
      btnTheme.innerHTML = `🎨 <span class="cds-mm-btn-text">${themeLabels[this.theme]}</span>`;
      this.applyTheme();
      this.saveLayoutMemory();
      new Notice(`🎨 Tema applicato: ${themeLabels[this.theme]}`);
    };

    // GRUPPO 2: STILE & CONNETTORI
    const groupStyle = this.topDock.createDiv({ cls: 'cds-mm-dock-group' });

    const connectorIcons = { curved: '🌊 Curvi', orthogonal: '📐 90°', straight: '📏 Lineari' };
    const btnConnector = groupStyle.createEl('button', {
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

    const btnOrganic = groupStyle.createEl('button', {
      cls: 'cds-mm-dock-btn' + (this.isOrganicView ? ' is-active' : ''),
      attr: { title: 'Alterna Stile Caselle e Vista Organica' }
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

    // DENSITÀ SPAZIATURA (v1.8.0 Anti-Spazio Vuoto)
    const densityLabels = {
      compact: '📏 Compatto',
      'ultra-compact': '⚡ Ultra',
      standard: '📐 Ampio'
    };
    const btnDensity = groupStyle.createEl('button', {
      cls: 'cds-mm-dock-btn',
      attr: { title: 'Densità spaziatura: Compatto (Zero Vuoto), Ultra-Compatto o Ampio Standard' }
    });
    btnDensity.innerHTML = `${densityLabels[this.spacingDensity] || '📏 Compatto'}`;
    btnDensity.onmousedown = (e) => e.stopPropagation();
    btnDensity.onclick = (e) => {
      e.stopPropagation();
      const densities = ['compact', 'ultra-compact', 'standard'];
      const nextIdx = (densities.indexOf(this.spacingDensity || 'compact') + 1) % densities.length;
      this.spacingDensity = densities[nextIdx];
      btnDensity.innerHTML = densityLabels[this.spacingDensity];
      this.saveLayoutMemory();
      this.render();
      new Notice('📏 Spaziatura: ' + this.spacingDensity.toUpperCase());
    };
    // ORDINE DELLA MAPPA (Cronologico Discendente vs Bilanciato)
    const orderLabels = { chronological: '⏳ Cronologico', balanced: '⚖️ Bilanciato' };
    const btnOrder = groupStyle.createEl('button', {
      cls: 'cds-mm-dock-btn' + (this.mapOrder === 'chronological' ? ' is-active' : ''),
      attr: { title: 'Alterna Ordine: Cronologico Discendente (Cap. 1, 2, 3...) o Bilanciato per altezza' }
    });
    btnOrder.innerHTML = `<span class="cds-mm-btn-text">${orderLabels[this.mapOrder || 'chronological']}</span>`;
    btnOrder.onmousedown = (e) => e.stopPropagation();
    btnOrder.onclick = (e) => {
      e.stopPropagation();
      this.mapOrder = (this.mapOrder === 'chronological' ? 'balanced' : 'chronological');
      btnOrder.innerHTML = `<span class="cds-mm-btn-text">${orderLabels[this.mapOrder]}</span>`;
      btnOrder.classList.toggle('is-active', this.mapOrder === 'chronological');
      this.saveLayoutMemory();
      this.render();
      new Notice(`🧭 Ordine Mappa: ${orderLabels[this.mapOrder].toUpperCase()}`);
    };


    // Dettaglio
    const mkDetailBtn = (lvl, label, icon, tip) => {
      const b = groupStyle.createEl('button', {
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
    mkDetailBtn('titles', 'Titoli', '🏷️', 'Mostra solo titoli H1..H6');
    mkDetailBtn('keypoints', 'Punti', '🎯', 'Mostra titoli e concetti chiave');
    mkDetailBtn('full', 'Tutto', '📖', 'Mostra testo completo');

    // GRUPPO 3: STRUMENTI OPERATIVI (Figlio, Fratello, Elimina)
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

    // Modalità Ripasso Orale
    const btnStudy = groupTools.createEl('button', {
      cls: 'cds-mm-dock-btn' + (this.isStudyMode ? ' is-active' : ''),
      attr: { title: 'Modalità Ripasso Orale (Flashcard)' }
    });
    btnStudy.innerHTML = '🎓 <span class="cds-mm-btn-text">Ripasso</span>';
    btnStudy.onmousedown = (e) => e.stopPropagation();
    btnStudy.onclick = (e) => {
      e.stopPropagation();
      this.toggleStudyMode();
    };

    // Etichetta passo spostamento tastiera + undo (v1.9.4)
    const stepLabel = groupTools.createSpan({ cls: 'cds-mm-step-label' });
    stepLabel.textContent = '⌨️ Passo: 8px · ⇧32px · Ctrl+Z';
    stepLabel.title = 'Sposta il nodo selezionato con le frecce (8px, Shift = 32px). Ctrl+Z annulla l\'ultimo spostamento.';

    // GRUPPO 4: CANVAS & ESPORTAZIONE
    const groupCanvas = this.topDock.createDiv({ cls: 'cds-mm-dock-group' });

    const mkCanvasBtn = (icon, tip, onClick, isActive = false) => {
      const b = groupCanvas.createEl('button', {
        cls: 'cds-mm-dock-btn' + (isActive ? ' is-active' : ''),
        attr: { title: tip }
      });
      b.innerHTML = icon;
      b.onmousedown = (e) => e.stopPropagation();
      b.onclick = (e) => { e.stopPropagation(); onClick(); };
      return b;
    };

    mkCanvasBtn('🔍 <span class="cds-mm-btn-text">Adatta</span>', 'Adatta mappa allo schermo (Fit-All)', () => this.fitToScreen());
    mkCanvasBtn('🧭', 'Centra la radice (Ctrl+E)', () => this.centerRoot());
    mkCanvasBtn('🔄', 'Cancella memoria mappa e ripristina geometria pulita', () => this.resetLayoutMemory());
    mkCanvasBtn('📄', 'Mostra perimetro foglio A0-A6 sul canvas', () => this.toggleSheetOverlay(), this.showSheetOverlay);
    mkCanvasBtn('🗺️', 'Attiva/Disattiva Minimap Radar', () => this.toggleMinimap());
    mkCanvasBtn('📤 <span class="cds-mm-btn-text">Esporta</span>', 'Esporta in PDF, PNG, SVG Vettoriale da A0 ad A6', () => this.openExportModal());
    mkCanvasBtn('🗺️ <span class="cds-mm-btn-text">Canvas (.canvas)</span>', 'Esporta e apri direttamente in Obsidian Canvas nativo (.canvas)', () => this.openInObsidianCanvas());

    // GRUPPO 5: RICERCA CON NAVIGAZIONE SEQUENZIALE
    const groupSearch = this.topDock.createDiv({ cls: 'cds-mm-dock-group cds-mm-search-dock-group' });
    
    const inpSearch = groupSearch.createEl('input', {
      type: 'text',
      placeholder: '🔍 Cerca...',
      cls: 'cds-mm-dock-search'
    });
    inpSearch.style.cssText = 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);border-radius:12px;padding:3px 8px;font-size:0.75rem;color:#f8fafc;width:95px;outline:none;';
    inpSearch.onfocus = () => { inpSearch.style.width = '130px'; inpSearch.style.borderColor = '#38bdf8'; };
    inpSearch.onblur = () => { if (!inpSearch.value) inpSearch.style.width = '95px'; };
    inpSearch.onmousedown = (e) => e.stopPropagation();

    const countBadge = groupSearch.createSpan({ cls: 'cds-mm-search-count' });
    countBadge.style.cssText = 'font-size:0.7rem;color:#fbbf24;font-weight:700;padding:0 2px;display:none;';

    const btnPrev = groupSearch.createEl('button', { cls: 'cds-mm-dock-btn search-nav-btn', attr: { title: 'Precedente (Shift+Enter)' } });
    btnPrev.innerHTML = '◀';
    btnPrev.style.cssText = 'padding:2px 4px;font-size:0.7rem;display:none;';

    const btnNext = groupSearch.createEl('button', { cls: 'cds-mm-dock-btn search-nav-btn', attr: { title: 'Successivo (Enter)' } });
    btnNext.innerHTML = '▶';
    btnNext.style.cssText = 'padding:2px 4px;font-size:0.7rem;display:none;';

    let searchMatches = [];
    let searchIdx = 0;

    const updateSearchHighlight = () => {
      if (!searchMatches.length) {
        countBadge.style.display = 'none';
        btnPrev.style.display = 'none';
        btnNext.style.display = 'none';
        return;
      }
      countBadge.style.display = 'inline-block';
      btnPrev.style.display = 'inline-block';
      btnNext.style.display = 'inline-block';
      countBadge.textContent = `${searchIdx + 1}/${searchMatches.length}`;

      const target = searchMatches[searchIdx];
      if (target) {
        this.selectNode(target.id);
        this.centerOnNode(target);
        const el = this.nodesLayer.querySelector(`[data-node-id="${target.id}"]`);
        if (el) {
          el.style.boxShadow = '0 0 24px rgba(251, 191, 36, 1), 0 0 0 3px #fbbf24';
        }
      }
    };

    inpSearch.oninput = () => {
      const q = inpSearch.value.trim().toLowerCase();
      searchMatches = [];
      searchIdx = 0;

      const allEls = this.nodesLayer.querySelectorAll('.cds-mm-node');
      allEls.forEach(el => {
        const nid = el.getAttribute('data-node-id');
        const nodeObj = this.renderedNodes.find(n => n.id === nid);
        if (!q) {
          el.style.opacity = '1';
          el.style.boxShadow = '';
        } else if (el.textContent.toLowerCase().includes(q)) {
          el.style.opacity = '1';
          el.style.boxShadow = '0 0 16px rgba(251, 191, 36, 0.8), 0 0 0 2px #fbbf24';
          if (nodeObj) searchMatches.push(nodeObj);
        } else {
          el.style.opacity = '0.22';
          el.style.boxShadow = '';
        }
      });

      if (q && searchMatches.length > 0) {
        updateSearchHighlight();
      } else {
        countBadge.style.display = 'none';
        btnPrev.style.display = 'none';
        btnNext.style.display = 'none';
      }
    };

    btnNext.onclick = (e) => {
      e.stopPropagation();
      if (!searchMatches.length) return;
      searchIdx = (searchIdx + 1) % searchMatches.length;
      updateSearchHighlight();
    };

    btnPrev.onclick = (e) => {
      e.stopPropagation();
      if (!searchMatches.length) return;
      searchIdx = (searchIdx - 1 + searchMatches.length) % searchMatches.length;
      updateSearchHighlight();
    };

    inpSearch.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) btnPrev.click();
        else btnNext.click();
      }
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

    // Calcolo spaziature dinamiche in base alla densità selezionata (v1.8.0)
    let hGap = 45, vGap = 12, cGap = 16;
    if (this.spacingDensity === 'ultra-compact') {
      hGap = 35; vGap = 8; cGap = 10;
    } else if (this.spacingDensity === 'standard') {
      hGap = 65; vGap = 18; cGap = 24;
    }

    let layout;
    const layoutOpts = {
      detailLevel: this.detailLevel,
      connectorStyle: this.connectorStyle,
      mapOrder: this.mapOrder || 'chronological',
      horizontalGap: hGap,
      verticalGap: vGap,
      chapterGap: cGap
    };
    if (this.viewMode === 'radial') {
      layout = MindmapEngine.computeRadialLayout(activeTree, layoutOpts);
    } else if (this.viewMode === 'bilateral') {
      layout = MindmapEngine.computeBilateralLayout(activeTree, layoutOpts);
    } else {
      layout = MindmapEngine.computeRightLayout(activeTree, layoutOpts);
    }

    this.renderedNodes = layout.nodes;
    this.renderedPaths = layout.paths;

    // Render Gruppi Canvas (v1.8.0)
    this.renderGroups();

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

    // Render Controlli Tratti / Bottoni + sul ramo (v1.8.0)
    this.renderEdgeControls();

    this.nodesLayer.empty();
    let selectedNodeEl = null;

    for (const node of this.renderedNodes) {
      if (node.x + node.width > maxX) maxX = node.x + node.width + 220;
      if (node.y + node.height > maxY) maxY = node.y + node.height + 220;

      const isSelected = node.id === this.selectedNodeId;
      const isMultiSelected = this.selectedNodeIds && this.selectedNodeIds.has(node.id);

      const nodeEl = this.nodesLayer.createDiv({
        cls: 'cds-mm-node' +
          (node.isRoot ? ' is-root' : ` level-${node.depth}`) +
          ((this.isOrganicView || node.isOrganic) ? ' is-organic' : '') +
          (node.type === 'keypoint' ? ' is-keypoint' : '') +
          (node.layout === 'table' ? ' is-table-node' : '') +
          (isSelected ? ' is-selected' : '') +
          (isMultiSelected ? ' is-multi-selected' : '') +
          (node.direction === 'left' ? ' is-left' : ' is-right')
      });

      nodeEl.setAttribute('data-node-id', node.id);
      nodeEl.setAttribute('data-id', node.id);
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
              this.openImageLightbox(src, node.text);
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

        // AZIONI RAPIDE INTEGRATE DIRETTAMENTE NEL NODO (v1.8.0)
        const nodeActions = nodeEl.createDiv({ cls: 'cds-mm-node-actions' });
        
        const btnChild = nodeActions.createEl('button', {
          cls: 'cds-mm-node-act-btn act-child',
          attr: { title: 'Aggiungi concetto figlio (Tab)' }
        });
        btnChild.innerHTML = '➕ <span class="cds-mm-act-lbl">Figlio</span>';
        btnChild.onmousedown = (e) => { e.stopPropagation(); e.preventDefault(); };
        btnChild.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.selectNode(node.id);
          this.addChildToSelected('Nuovo Concetto', null, node.id);
        };

        if (!node.isRoot) {
          const btnSibling = nodeActions.createEl('button', {
            cls: 'cds-mm-node-act-btn act-sibling',
            attr: { title: 'Aggiungi concetto fratello (Enter)' }
          });
          btnSibling.innerHTML = '⏬ <span class="cds-mm-act-lbl">Fratello</span>';
          btnSibling.onmousedown = (e) => { e.stopPropagation(); e.preventDefault(); };
          btnSibling.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.selectNode(node.id);
            this.addSiblingToSelected('Nuovo Concetto', node.id);
          };

          const btnColor = nodeActions.createEl('button', {
            cls: 'cds-mm-node-act-btn act-color',
            attr: { title: 'Cambia colore evidenziazione nodo' }
          });
          btnColor.innerHTML = '🎨';
          btnColor.onmousedown = (e) => { e.stopPropagation(); e.preventDefault(); };
          btnColor.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.cycleNodeColor(node);
          };

          const btnDelete = nodeActions.createEl('button', {
            cls: 'cds-mm-node-act-btn act-delete',
            attr: { title: 'Elimina concetto' }
          });
          btnDelete.innerHTML = '🗑️';
          btnDelete.onmousedown = (e) => { e.stopPropagation(); e.preventDefault(); };
          btnDelete.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.selectNode(node.id);
            this.deleteSelected();
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
        if (((ev.ctrlKey || ev.metaKey) && ev.target.closest('.cds-mm-wikilink')) ||
            ev.target.closest('a') ||
            ev.target.closest('.cds-mm-pdf-badge') ||
            ev.target.closest('.cds-mm-fold-btn') ||
            ev.target.closest('.cds-mm-footnote') ||
            ev.target.closest('.cds-mm-node-actions') ||
            ev.target.closest('.cds-mm-resize-handle')) {
          return;
        }

        // Selezione Multipla con Shift / Ctrl / Cmd (v1.8.1)
        if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
          ev.stopPropagation();
          if (!this.selectedNodeIds) this.selectedNodeIds = new Set();
          if (this.selectedNodeIds.has(node.id)) {
            this.selectedNodeIds.delete(node.id);
            if (this.selectedNodeId === node.id) {
              this.selectedNodeId = this.selectedNodeIds.size > 0 ? Array.from(this.selectedNodeIds)[0] : null;
            }
          } else {
            this.selectedNodeIds.add(node.id);
            this.selectedNodeId = node.id;
          }
          this.updateSelectionVisuals();
          this.updateMultiSelectToolbar();
          return;
        }

        // Selezione Singola Standard:
        // Se il nodo non fa parte della selezione multipla attiva, reimposta la selezione su questo nodo
        if (!this.selectedNodeIds) this.selectedNodeIds = new Set();
        if (!this.selectedNodeIds.has(node.id)) {
          this.selectedNodeIds.clear();
          this.selectedNodeIds.add(node.id);
        }
        this.selectedNodeId = node.id;
        this.updateSelectionVisuals();
        this.updateMultiSelectToolbar();

        ev.stopPropagation();
        this.selectNode(node.id);

        if (this.options.onNodeClick) {
          this.options.onNodeClick(node);
        }

        // v1.9.4: anche la radice è trascinabile col mouse (e spostabile con le frecce)
        if (ev.button === 0) {
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

    const finalStageW = Math.max(maxX + 120, 1800);
    const finalStageH = Math.max(maxY + 120, 1400);

    this.svgLayer.setAttribute('width', `${finalStageW}`);
    this.svgLayer.setAttribute('height', `${finalStageH}`);
    this.svgLayer.setAttribute('viewBox', `0 0 ${finalStageW} ${finalStageH}`);
    this.stage.style.width = `${finalStageW}px`;
    this.stage.style.height = `${finalStageH}px`;

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

    // Palette Colori per il nodo (v1.8.0)
    const colorGroup = this.floatingBar.createDiv({ cls: 'cds-mm-float-color-group' });
    colorGroup.style.cssText = 'display:flex;align-items:center;gap:3px;margin:0 4px;';
    const pal = [
      { name: 'Celeste', hex: '#38bdf8' },
      { name: 'Smeraldo', hex: '#10b981' },
      { name: 'Ambra', hex: '#fbbf24' },
      { name: 'Corallo', hex: '#f43f5e' },
      { name: 'Viola', hex: '#a855f7' },
      { name: 'Reset', hex: null }
    ];
    for (const c of pal) {
      const dot = colorGroup.createEl('span', {
        cls: 'cds-mm-color-dot',
        attr: { title: `Colora nodo: ${c.name}` }
      });
      dot.style.cssText = `width:13px;height:13px;border-radius:50%;background:${c.hex || '#64748b'};cursor:pointer;display:inline-block;border:1.5px solid rgba(255,255,255,0.4);transition:transform 0.15s ease;`;
      dot.onmouseenter = () => dot.style.transform = 'scale(1.25)';
      dot.onmouseleave = () => dot.style.transform = 'scale(1)';
      dot.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        rawNode.customColor = c.hex;
        const rendered = this.renderedNodes.find(n => n.id === rawNode.id);
        if (rendered) rendered.customColor = c.hex;
        this.saveLayoutMemory();
        this.render();
      };
    }

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
    let isDraggingMinimap = false;

    const onMinimapMove = (e) => {
      if (!isDraggingMinimap) return;
      this.panWithMinimap(e);
    };

    const onMinimapUp = () => {
      isDraggingMinimap = false;
      window.removeEventListener('mousemove', onMinimapMove);
      window.removeEventListener('mouseup', onMinimapUp);
    };

    this.minimapWrap.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      isDraggingMinimap = true;
      this.panWithMinimap(e);
      window.addEventListener('mousemove', onMinimapMove);
      window.addEventListener('mouseup', onMinimapUp);
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

  async openInObsidianCanvas() {
    try {
      if (!this.rawRootNode) {
        new Notice('Nessuna mappa concettuale attiva.');
        return;
      }

      const canvasData = MindmapEngine.exportToObsidianCanvas(this.rawRootNode, {
        detailLevel: this.detailLevel,
        viewMode: this.viewMode,
        groups: this.groups,
        spacingDensity: this.spacingDensity
      });

      const baseName = (this.rawRootNode.text || 'Mappa_Concettuale').replace(/[/\\?%*:|"<>]/g, '_').trim();
      // v1.9.5: esporta SEMPRE nella cartella canonica "Mappe Concettuali/" e NON
      // accanto alla nota: l'esportazione accanto alla nota ricreava doppioni .canvas
      // nel folder della nota (es. Approfondimenti/Cap 12 La fotografia.canvas).
      const CANONICAL_CANVAS_FOLDER = 'Mappe Concettuali';
      let canvasPath = '';
      if (this.filePath && this.filePath.startsWith(CANONICAL_CANVAS_FOLDER + '/')) {
        const folder = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
        canvasPath = `${folder}/${baseName}.canvas`;
      } else {
        canvasPath = `${CANONICAL_CANVAS_FOLDER}/${baseName}.canvas`;
      }

      const jsonStr = JSON.stringify(canvasData, null, 2);
      const existingFile = this.app.vault.getAbstractFileByPath(canvasPath);

      if (existingFile) {
        await this.app.vault.modify(existingFile, jsonStr);
      } else {
        const parentFolder = canvasPath.includes('/') ? canvasPath.substring(0, canvasPath.lastIndexOf('/')) : '';
        if (parentFolder && !this.app.vault.getAbstractFileByPath(parentFolder)) {
          try {
            await this.app.vault.createFolder(parentFolder);
          } catch(e) {}
        }
        await this.app.vault.create(canvasPath, jsonStr);
      }

      new Notice(`🗺️ Mappa esportata in Obsidian Canvas: ${canvasPath}`);
      const cFile = this.app.vault.getAbstractFileByPath(canvasPath);
      if (cFile && cFile instanceof TFile) {
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.openFile(cFile);
      } else {
        await this.app.workspace.openLinkText(canvasPath, '', true);
      }
    } catch(err) {
      console.error('[CDS Mindmap] Error opening in Obsidian Canvas:', err);
      new Notice(`⚠️ Errore apertura Canvas: ${err.message}`);
    }
  }

  initNodeDrag(node, nodeEl, ev) {
    const rawNode = this.findRawNode(node.id);
    if (!rawNode) return;

    // Raccoglie tutti i nodi selezionati se siamo in modalità Multi-Selezione (v1.8.0)
    const multiGroup = [];
    if (this.selectedNodeIds && this.selectedNodeIds.has(node.id) && this.selectedNodeIds.size > 1) {
      for (const id of this.selectedNodeIds) {
        const n = this.renderedNodes.find(item => item.id === id);
        const el = this.nodesLayer.querySelector(`[data-id="${id}"]`) || this.nodesLayer.querySelector(`[data-node-id="${id}"]`);
        if (n) {
          multiGroup.push({
            node: n,
            el: el || null,
            origX: n.x,
            origY: n.y,
            rawNode: this.findRawNode(id)
          });
        }
      }
    }

    // Cronologia per Ctrl+Z: posizioni ORIGINALI (pre-drag) dei nodi che si muoveranno
    const historyIds = new Set([node.id]);
    for (const d of this.collectDescendants(node)) historyIds.add(d.node.id);
    for (const item of multiGroup) historyIds.add(item.node.id);
    const historySnapshot = [];
    for (const hid of historyIds) {
      const hn = this.renderedNodes.find(item => item.id === hid);
      if (hn) historySnapshot.push({ id: hn.id, x: hn.x, y: hn.y });
    }

    this.draggedNodeState = {
      node,
      rawNode,
      nodeEl,
      startX: ev.clientX,
      startY: ev.clientY,
      nodeOrigX: node.x,
      nodeOrigY: node.y,
      hasMoved: false,
      descendants: this.collectDescendants(node),
      multiGroup,
      historySnapshot
    };
  }

  // Registra uno snapshot nella cronologia per Ctrl+Z (limitato a N voci).
  pushMoveHistory(snapshot) {
    if (!snapshot || !snapshot.length) return;
    this.moveHistory.push(snapshot);
    if (this.moveHistory.length > this.moveHistoryLimit) this.moveHistory.shift();
  }

  // Ctrl+Z: ripristina le posizioni dell'ultimo spostamento (frecce, drag, gruppi).
  undoMove() {
    const snapshot = this.moveHistory.pop();
    if (!snapshot || !snapshot.length) {
      new Notice('↩️ Niente da annullare');
      return;
    }
    for (const item of snapshot) {
      const n = this.renderedNodes.find(rd => rd.id === item.id);
      const raw = this.findRawNode(item.id);
      if (n) { n.x = item.x; n.y = item.y; }
      if (raw) { raw.customX = item.x; raw.customY = item.y; }
    }
    this.updateBranchPathsRealtime();
    this.updateGroupsRealtime();
    this.renderEdgeControls();
    this.saveLayoutMemory();
    this.render();
    new Notice('↩️ Spostamento annullato');
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
    if (this.isMarquee && this.marqueeStart) {
      const rect = this.stage.getBoundingClientRect();
      const curX = (ev.clientX - rect.left) / this.zoom;
      const curY = (ev.clientY - rect.top) / this.zoom;
      const boxX = Math.min(this.marqueeStart.x, curX);
      const boxY = Math.min(this.marqueeStart.y, curY);
      const boxW = Math.abs(curX - this.marqueeStart.x);
      const boxH = Math.abs(curY - this.marqueeStart.y);

      this.marqueeEl.style.left = `${boxX}px`;
      this.marqueeEl.style.top = `${boxY}px`;
      this.marqueeEl.style.width = `${boxW}px`;
      this.marqueeEl.style.height = `${boxH}px`;

      for (const n of this.renderedNodes) {
        const intersects = !(n.x > boxX + boxW || 
                             n.x + n.width < boxX || 
                             n.y > boxY + boxH || 
                             n.y + n.height < boxY);
        if (intersects) {
          this.selectedNodeIds.add(n.id);
        }
      }
      this.updateSelectionVisuals();
      return;
    }

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
        if (s.multiGroup && s.multiGroup.length > 1) {
          // Spostamento simultaneo di tutti i nodi selezionati (v1.8.0 Multi-Drag)
          for (const item of s.multiGroup) {
            item.node.x = Math.round(item.origX + dx);
            item.node.y = Math.round(item.origY + dy);
            item.el.style.left = `${item.node.x}px`;
            item.el.style.top = `${item.node.y}px`;
          }
          this.updateBranchPathsRealtime();
          this.updateGroupsRealtime();
          this.renderEdgeControls();
        } else {
          const newX = Math.round(s.nodeOrigX + dx);
          const newY = Math.round(s.nodeOrigY + dy);
          s.node.x = newX;
          s.node.y = newY;
          s.nodeEl.style.left = `${newX}px`;
          s.nodeEl.style.top = `${newY}px`;

          for (const desc of s.descendants) {
            desc.node.x = Math.round(desc.origX + dx);
            desc.node.y = Math.round(desc.origY + dy);
            const el = this.nodesLayer.querySelector(`[data-id="${desc.node.id}"]`) || this.nodesLayer.querySelector(`[data-node-id="${desc.node.id}"]`);
            if (el) {
              el.style.left = `${desc.node.x}px`;
              el.style.top = `${desc.node.y}px`;
            }
          }

          this.updateBranchPathsRealtime();
          this.updateGroupsRealtime();
          this.renderEdgeControls();
        }

        // Riparentazione SOLO con modificatore (Alt/Ctrl): senza, il drag col mouse
        // sposta liberamente il nodo senza che venga "assorbito" da quelli vicini
        // (era la causa dello spostamento "rotto" percepito).
        const wantReparent = (ev.altKey || ev.ctrlKey || ev.metaKey);
        document.querySelectorAll('.cds-mm-node.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
        if (wantReparent) {
          const els = document.elementsFromPoint(ev.clientX, ev.clientY);
          const targetEl = els.find(el => el.classList && el.classList.contains('cds-mm-node') && el !== s.nodeEl);
          if (targetEl) {
            targetEl.classList.add('is-drop-target');
            s.hoverTargetId = targetEl.getAttribute('data-node-id');
          } else {
            s.hoverTargetId = null;
          }
        } else {
          s.hoverTargetId = null;
        }
      }
    }
  }

  onMouseUp(ev) {
    if (this.isMarquee) {
      this.isMarquee = false;
      if (this.marqueeEl) {
        this.marqueeEl.style.display = 'none';
      }
      this.updateSelectionVisuals();
      this.updateMultiSelectToolbar();
    }

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
        // Riparenta SOLO se si rilascia tenendo Alt/Ctrl sul nodo di destinazione
        const doReparent = (ev.altKey || ev.ctrlKey || ev.metaKey) && s.hoverTargetId && s.hoverTargetId !== s.node.id;
        if (doReparent) {
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

              new Notice(`Riparentato "${s.rawNode.text.slice(0, 20)}" sotto "${newParent.text.slice(0, 20)}" (Alt/Ctrl + rilascio)`);
              this.render();
              this.triggerSave();
              return;
            }
          }
        }

        // Registra lo spostamento nella cronologia Ctrl+Z (posizioni pre-drag)
        this.pushMoveHistory(s.historySnapshot);

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
        const isRight = (toNode.x + toNode.width / 2) >= (fromNode.x + fromNode.width / 2);
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


  // ==========================================================================
  // METODI v1.8.0: AGGIUNTA NODI NEL TRATTO, SELEZIONE MULTIPLA E GRUPPI
  // ==========================================================================
  renderEdgeControls() {
    if (!this.edgesControlsLayer) return;
    this.edgesControlsLayer.empty();
    if (!this.renderedPaths || !this.renderedPaths.length) return;

    for (const p of this.renderedPaths) {
      const fromNode = this.renderedNodes.find(n => n.id === p.fromId);
      const toNode = this.renderedNodes.find(n => n.id === p.toId);
      if (!fromNode || !toNode) continue;

      const isRight = (toNode.x + toNode.width / 2) >= (fromNode.x + fromNode.width / 2);
      const startX = isRight ? fromNode.x + fromNode.width : fromNode.x;
      const startY = fromNode.y + fromNode.height / 2;
      const targetX = isRight ? toNode.x : toNode.x + toNode.width;
      const targetY = toNode.y + toNode.height / 2;
      const midX = Math.round((startX + targetX) / 2);
      const midY = Math.round((startY + targetY) / 2);

      const btn = this.edgesControlsLayer.createDiv({ cls: 'cds-mm-edge-add-btn' });
      btn.style.left = `${midX - 11}px`;
      btn.style.top = `${midY - 11}px`;
      btn.setAttribute('title', '➕ Inserisci concetto in questo tratto');
      btn.innerHTML = '+';
      btn.onmousedown = (e) => { e.stopPropagation(); e.preventDefault(); };
      btn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.insertNodeOnEdge(p.fromId, p.toId, midX, midY);
      };
    }
  }

  insertNodeOnEdge(fromId, toId, midX, midY) {
    const fromRaw = this.findRawNode(fromId);
    const toRaw = this.findRawNode(toId);
    if (!fromRaw || !toRaw) return;

    const newNodeId = 'node_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const newNode = {
      id: newNodeId,
      text: 'Nuovo Concetto',
      depth: (fromRaw.depth || 0) + 1,
      type: 'keypoint',
      children: [toRaw],
      collapsed: false,
      customX: Math.round(midX - 90),
      customY: Math.round(midY - 25),
      isCanvasAdded: true,
      bodyText: ''
    };

    if (!fromRaw.children) fromRaw.children = [];
    const idx = fromRaw.children.findIndex(c => c.id === toId);
    if (idx !== -1) {
      fromRaw.children[idx] = newNode;
    } else {
      fromRaw.children.push(newNode);
    }
    toRaw.depth = newNode.depth + 1;

    this.saveLayoutMemory();
    this.render();

    this.selectedNodeId = newNodeId;
    this.selectedNodeIds = new Set([newNodeId]);
    this.updateSelectionVisuals();

    const newEl = this.nodesLayer.querySelector(`[data-id="${newNodeId}"]`) || this.nodesLayer.querySelector(`[data-node-id="${newNodeId}"]`);
    if (newEl) {
      this.startEditing(newNode, newEl);
    }
    new Notice('➕ Concetto inserito nel tratto! Scrivi il titolo e premi Invio.');
  }

  updateSelectionVisuals() {
    this.nodesLayer.querySelectorAll('.cds-mm-node').forEach(el => {
      const id = el.getAttribute('data-id') || el.getAttribute('data-node-id');
      if (this.selectedNodeIds && this.selectedNodeIds.has(id)) {
        el.classList.add('is-multi-selected');
      } else {
        el.classList.remove('is-multi-selected');
      }
      if (id === this.selectedNodeId) {
        el.classList.add('is-selected');
      } else if (!this.selectedNodeIds || !this.selectedNodeIds.has(id)) {
        el.classList.remove('is-selected');
      }
    });
  }

  updateMultiSelectToolbar() {
    if (!this.multiSelectToolbar) return;
    if (!this.selectedNodeIds || this.selectedNodeIds.size <= 1) {
      this.multiSelectToolbar.style.display = 'none';
      return;
    }

    this.multiSelectToolbar.style.display = 'flex';
    this.multiSelectToolbar.empty();

    const countBadge = this.multiSelectToolbar.createDiv({ cls: 'cds-mm-multi-badge' });
    countBadge.innerHTML = `🎯 <b>${this.selectedNodeIds.size}</b> nodi selezionati`;

    // Pulsante Crea Gruppo
    const btnGroup = this.multiSelectToolbar.createEl('button', { cls: 'cds-mm-btn-primary' });
    btnGroup.innerHTML = '📦 Raggruppa';
    btnGroup.title = 'Raggruppa i nodi selezionati in un riquadro / frame';
    btnGroup.onclick = (e) => {
      e.stopPropagation();
      this.createGroupFromSelection();
    };

    // Pulsante Colora Insieme
    const btnColor = this.multiSelectToolbar.createEl('button', { cls: 'cds-mm-btn-secondary' });
    btnColor.innerHTML = '🎨 Colora';
    btnColor.title = 'Applica colore a tutti i nodi selezionati';
    btnColor.onclick = (e) => {
      e.stopPropagation();
      this.colorSelection();
    };

    // Pulsante Deseleziona
    const btnClear = this.multiSelectToolbar.createEl('button', { cls: 'cds-mm-mini-btn' });
    btnClear.innerHTML = '✕ Deseleziona';
    btnClear.onclick = (e) => {
      e.stopPropagation();
      this.selectedNodeIds.clear();
      this.updateSelectionVisuals();
      this.updateMultiSelectToolbar();
    };
  }

  createGroupFromSelection() {
    if (!this.selectedNodeIds || this.selectedNodeIds.size === 0) return;
    const title = prompt('Nome del nuovo gruppo:', `Gruppo (${this.selectedNodeIds.size} concetti)`);
    if (!title) return;

    const grp = {
      id: 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      label: title,
      color: '#38bdf8',
      nodeIds: Array.from(this.selectedNodeIds)
    };

    if (!this.groups) this.groups = [];
    this.groups.push(grp);
    this.saveLayoutMemory();
    this.render();
    new Notice(`📦 Gruppo "${title}" creato con ${grp.nodeIds.length} concetti!`);
  }

  colorSelection() {
    if (!this.selectedNodeIds || this.selectedNodeIds.size === 0) return;
    const palette = ['#38bdf8', '#818cf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa'];
    const randomCol = palette[Math.floor(Math.random() * palette.length)];

    for (const id of this.selectedNodeIds) {
      const raw = this.findRawNode(id);
      if (raw) raw.customColor = randomCol;
    }
    this.saveLayoutMemory();
    this.render();
    new Notice(`🎨 Colore applicato a ${this.selectedNodeIds.size} nodi!`);
  }

  renderGroups() {
    if (!this.groupsLayer) return;
    this.groupsLayer.empty();
    if (!this.groups || !this.groups.length) return;

    for (const grp of this.groups) {
      const memberNodes = this.renderedNodes.filter(n => grp.nodeIds.includes(n.id));
      if (!memberNodes.length) continue;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of memberNodes) {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.width);
        maxY = Math.max(maxY, n.y + n.height);
      }

      const pad = 24;
      const headerH = 34;
      const gx = Math.round(minX - pad);
      const gy = Math.round(minY - pad - headerH);
      const gw = Math.round((maxX - minX) + pad * 2);
      const gh = Math.round((maxY - minY) + pad * 2 + headerH);

      const grpEl = this.groupsLayer.createDiv({ cls: 'cds-mm-group-box' });
      grpEl.setAttribute('data-group-id', grp.id);
      grpEl.style.left = `${gx}px`;
      grpEl.style.top = `${gy}px`;
      grpEl.style.width = `${gw}px`;
      grpEl.style.height = `${gh}px`;
      grpEl.style.borderColor = grp.color || '#38bdf8';
      grpEl.style.backgroundColor = (grp.color || '#38bdf8') + '12';

      // Header Gruppo
      const headerEl = grpEl.createDiv({ cls: 'cds-mm-group-header' });
      headerEl.style.backgroundColor = (grp.color || '#38bdf8') + '25';
      headerEl.style.borderBottomColor = (grp.color || '#38bdf8') + '40';

      const titleEl = headerEl.createSpan({ cls: 'cds-mm-group-title', text: `📦 ${grp.label}` });
      titleEl.title = 'Doppio clic per rinominare il gruppo';
      titleEl.ondblclick = (e) => {
        e.stopPropagation();
        const newLabel = prompt('Modifica nome del gruppo:', grp.label);
        if (newLabel) {
          grp.label = newLabel;
          this.saveLayoutMemory();
          this.render();
        }
      };

      const actionsEl = headerEl.createDiv({ cls: 'cds-mm-group-actions' });
      // Cambia colore
      const colBtn = actionsEl.createEl('button', { cls: 'cds-mm-group-btn', text: '🎨', attr: { title: 'Cambia colore gruppo' } });
      colBtn.onclick = (e) => {
        e.stopPropagation();
        const palette = ['#38bdf8', '#818cf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa'];
        const curIdx = palette.indexOf(grp.color || '#38bdf8');
        grp.color = palette[(curIdx + 1) % palette.length];
        this.saveLayoutMemory();
        this.render();
      };

      // Rimuovi gruppo
      const delBtn = actionsEl.createEl('button', { cls: 'cds-mm-group-btn', text: '✕', attr: { title: 'Rimuovi gruppo (mantieni i nodi)' } });
      delBtn.onclick = (e) => {
        e.stopPropagation();
        this.groups = this.groups.filter(g => g.id !== grp.id);
        this.saveLayoutMemory();
        this.render();
        new Notice('Gruppo rimosso (i nodi sono stati mantenuti).');
      };

      // Trascinando l'header del gruppo si spostano tutti i nodi membri
      headerEl.onmousedown = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        e.stopPropagation();
        this.initGroupDrag(grp, memberNodes, e);
      };
    }
  }

  updateGroupsRealtime() {
    if (!this.groups || !this.groups.length || !this.groupsLayer) return;
    for (const grp of this.groups) {
      const el = this.groupsLayer.querySelector(`[data-group-id="${grp.id}"]`);
      if (!el) continue;
      const members = this.renderedNodes.filter(n => grp.nodeIds.includes(n.id));
      if (!members.length) continue;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of members) {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.width);
        maxY = Math.max(maxY, n.y + n.height);
      }

      const pad = 24;
      const headerH = 34;
      el.style.left = `${Math.round(minX - pad)}px`;
      el.style.top = `${Math.round(minY - pad - headerH)}px`;
      el.style.width = `${Math.round((maxX - minX) + pad * 2)}px`;
      el.style.height = `${Math.round((maxY - minY) + pad * 2 + headerH)}px`;
    }
  }

  initGroupDrag(grp, memberNodes, ev) {
    const startItems = memberNodes.map(n => {
      const el = this.nodesLayer.querySelector(`[data-id="${n.id}"]`) || this.nodesLayer.querySelector(`[data-node-id="${n.id}"]`);
      return {
        node: n,
        el,
        origX: n.x,
        origY: n.y,
        rawNode: this.findRawNode(n.id)
      };
    });

    this.draggedGroupState = {
      grp,
      startItems,
      startX: ev.clientX,
      startY: ev.clientY,
      hasMoved: false,
      historySnapshot: startItems.map(i => ({ id: i.node.id, x: i.node.x, y: i.node.y }))
    };

    const onMove = (e) => {
      if (!this.draggedGroupState) return;
      const gs = this.draggedGroupState;
      const dx = (e.clientX - gs.startX) / this.zoom;
      const dy = (e.clientY - gs.startY) / this.zoom;

      if (!gs.hasMoved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        gs.hasMoved = true;
      }

      if (gs.hasMoved) {
        for (const item of gs.startItems) {
          item.node.x = Math.round(item.origX + dx);
          item.node.y = Math.round(item.origY + dy);
          if (item.el) {
            item.el.style.left = `${item.node.x}px`;
            item.el.style.top = `${item.node.y}px`;
          }
        }
        this.updateBranchPathsRealtime();
        this.updateGroupsRealtime();
        this.renderEdgeControls();
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (this.draggedGroupState && this.draggedGroupState.hasMoved) {
        // Cronologia Ctrl+Z: posizioni originali dei membri del gruppo
        this.pushMoveHistory(this.draggedGroupState.historySnapshot);
        for (const item of this.draggedGroupState.startItems) {
          if (item.rawNode) {
            item.rawNode.customX = item.node.x;
            item.rawNode.customY = item.node.y;
          }
        }
        this.saveLayoutMemory();
        this.render();
      }
      this.draggedGroupState = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  async saveLayoutMemory() {
    if (!this.plugin || !this.filePath) return;
    if (!this.plugin.settings) this.plugin.settings = { fileLayouts: {} };
    if (!this.plugin.settings.fileLayouts) this.plugin.settings.fileLayouts = {};

    const positions = {};
    const collapsed = [];
    const addedNodes = [];

    const walk = (n, parentId = null) => {
      if (n.customX !== undefined || n.customY !== undefined || n.customWidth !== undefined || n.customHeight !== undefined || n.layout || n.priority || n.customColor) {
        positions[n.id] = {
          text: n.text,
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
      if (n.isCanvasAdded) {
        const parentNode = parentId ? this.findRawNode(parentId) : null;
        addedNodes.push({
          id: n.id,
          parentId: parentId || 'root',
          parentText: parentNode ? parentNode.text : '',
          text: n.text,
          depth: n.depth,
          type: n.type || 'keypoint',
          customX: n.customX,
          customY: n.customY,
          customWidth: n.customWidth,
          customHeight: n.customHeight,
          customColor: n.customColor,
          priority: n.priority,
          bodyText: n.bodyText || '',
          pdfLink: n.pdfLink || null,
          images: n.images || null,
          tableData: n.tableData || null,
          isCanvasAdded: true
        });
      }
      if (n.collapsed) {
        collapsed.push(n.id);
      }
      if (n.children) n.children.forEach(c => walk(c, n.id));
    };
    walk(this.rawRootNode);

    this.plugin.settings.fileLayouts[this.filePath] = {
      positions,
      collapsed,
      addedNodes,
      viewMode: this.viewMode,
      detailLevel: this.detailLevel,
      connectorStyle: this.connectorStyle,
      theme: this.theme,
      isOrganicView: !!this.isOrganicView,
      spacingDensity: this.spacingDensity,
      groups: this.groups || [],
      panX: Math.round(this.panX),
      panY: Math.round(this.panY),
      zoom: Number(this.zoom.toFixed(2)),
      // v1.9.5: cronologia undo persistita (max 40 voci per non appesantire data.json)
      moveHistory: (this.moveHistory || []).slice(-40),
      updatedAt: Date.now()
    };

    CUSTOM_POSITIONS_CACHE.set(this.filePath, positions);
    CUSTOM_POSITIONS_CACHE.set(this.filePath + '_layout', this.plugin.settings.fileLayouts[this.filePath]);
    if (this.plugin.saveSettings) {
      this.plugin.saveSettings();
    }
  }

  async resetLayoutMemory() {
    // v1.9.5: azzerando il layout va azzerata anche la cronologia undo
    this.moveHistory = [];
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
    if (!this.selectedNodeId && (!this.selectedNodeIds || this.selectedNodeIds.size === 0)) return;
    this.selectedNodeId = null;
    if (this.selectedNodeIds) this.selectedNodeIds.clear();
    this.floatingBar.style.display = 'none';
    if (this.multiSelectToolbar) this.multiSelectToolbar.style.display = 'none';
    this.updateHierarchyGlow(null);
    this.nodesLayer.querySelectorAll('.cds-mm-node').forEach(el => {
      el.classList.remove('is-selected');
      el.classList.remove('is-multi-selected');
    });
    
    // Rimuovi indicatori di flash temporanei nell'editor Markdown
    const flashes = document.querySelectorAll('.cds-mm-editor-flash');
    flashes.forEach(f => f.remove());

    if (this.options.onDeselect) {
      this.options.onDeselect();
    }
  }

  selectNode(nodeId) {
    this.selectedNodeId = nodeId;
    if (!this.selectedNodeIds) this.selectedNodeIds = new Set();
    if (!this.selectedNodeIds.has(nodeId)) {
      this.selectedNodeIds.add(nodeId);
    }
    this.updateSelectionVisuals();
    this.updateHierarchyGlow(nodeId);
    const selEl = this.nodesLayer.querySelector(`[data-id="${nodeId}"]`) || this.nodesLayer.querySelector(`[data-node-id="${nodeId}"]`);
    if (selEl) {
      this.updateFloatingBar(selEl);
    }
  }

    findRawNodeByText(text, node = this.rawRootNode) {
    if (!text) return null;
    const cleanTarget = text.trim().toLowerCase();
    if ((node.text || '').trim().toLowerCase() === cleanTarget) return node;
    if (node.children) {
      for (const c of node.children) {
        const found = this.findRawNodeByText(text, c);
        if (found) return found;
      }
    }
    return null;
  }

  applySavedLayout(saved) {
    if (!saved) return;
    if (saved.theme) this.theme = saved.theme;
    if (saved.viewMode) this.viewMode = saved.viewMode;
    if (saved.mapOrder) this.mapOrder = saved.mapOrder;
    if (saved.detailLevel) this.detailLevel = saved.detailLevel;
    if (saved.connectorStyle) this.connectorStyle = saved.connectorStyle;
    if (saved.isOrganicView !== undefined) this.isOrganicView = saved.isOrganicView;
    if (saved.panX !== undefined) this.panX = saved.panX;
    if (saved.panY !== undefined) this.panY = saved.panY;
    if (saved.zoom !== undefined) this.zoom = saved.zoom;

    if (saved.positions) {
      for (const [id, pos] of Object.entries(saved.positions)) {
        let raw = this.findRawNode(id);
        if (!raw && pos.text) {
          raw = this.findRawNodeByText(pos.text);
        }
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

  addChildToSelected(defaultText = 'Nuovo Concetto', pdfLink = null, targetParentId = null) {
    let parent = null;
    const parentId = targetParentId || this.selectedNodeId;
    if (parentId) {
      parent = this.findRawNode(parentId);
    }
    if (!parent) {
      parent = this.rawRootNode;
    }
    if (!parent) return;

    // Assicura che il genitore e tutti i suoi antenati siano espansi
    let curr = parent;
    while (curr) {
      curr.collapsed = false;
      curr = this.findParent(curr.id);
    }

    if (!parent.children) parent.children = [];

    // Se il livello di dettaglio è solo titoli, passa automaticamente a keypoints per non nascondere il nuovo nodo
    if (this.detailLevel === 'titles') {
      this.detailLevel = 'keypoints';
    }

    const childIdx = parent.children.length;
    const parentPath = parent.id || 'root';
    const timestamp = Date.now().toString(36).slice(-4) + Math.floor(Math.random() * 100);
    const newId = MindmapEngine.generateDeterministicId(parentPath, childIdx, defaultText) + '_' + timestamp;

    const newNode = {
      id: newId,
      text: defaultText,
      depth: (parent.depth || 0) + 1,
      type: parent.depth === 0 ? 'heading' : 'keypoint',
      children: [],
      collapsed: false,
      pdfLink,
      isCanvasAdded: true,
      bodyText: '',
      layout: 'default'
    };

    parent.children.push(newNode);
    this.selectedNodeId = newNode.id;
    this.saveLayoutMemory();
    this.render();

    const rendered = this.renderedNodes.find(n => n.id === newNode.id);
    if (rendered) {
      this.centerOnNode(rendered);
    }

    setTimeout(() => {
      const nodeEl = this.nodesLayer.querySelector(`[data-node-id="${newNode.id}"]`);
      if (nodeEl) {
        this.startEditing(newNode, nodeEl);
      }
    }, 60);

    new Notice('➕ Nuovo concetto aggiunto!');
  }

  addSiblingToSelected(defaultText = 'Nuovo Concetto', targetNodeId = null) {
    const targetId = targetNodeId || this.selectedNodeId;
    if (!targetId || targetId === 'root') {
      this.addChildToSelected(defaultText);
      return;
    }

    const parent = this.findParent(targetId);
    if (!parent) {
      this.addChildToSelected(defaultText);
      return;
    }

    let curr = parent;
    while (curr) {
      curr.collapsed = false;
      curr = this.findParent(curr.id);
    }

    if (!parent.children) parent.children = [];

    if (this.detailLevel === 'titles') {
      this.detailLevel = 'keypoints';
    }

    const idx = parent.children.findIndex(c => c.id === targetId);
    const parentPath = parent.id || 'root';
    const childIdx = parent.children.length;
    const timestamp = Date.now().toString(36).slice(-4) + Math.floor(Math.random() * 100);
    const newId = MindmapEngine.generateDeterministicId(parentPath, childIdx, defaultText) + '_' + timestamp;

    const newNode = {
      id: newId,
      text: defaultText,
      depth: parent.depth !== undefined ? parent.depth + 1 : 1,
      type: parent.depth === 0 ? 'heading' : 'keypoint',
      children: [],
      collapsed: false,
      isCanvasAdded: true,
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

    const rendered = this.renderedNodes.find(n => n.id === newNode.id);
    if (rendered) {
      this.centerOnNode(rendered);
    }

    setTimeout(() => {
      const nodeEl = this.nodesLayer.querySelector(`[data-node-id="${newNode.id}"]`);
      if (nodeEl) {
        this.startEditing(newNode, nodeEl);
      }
    }, 60);

    new Notice('⏬ Nuovo concetto fratello aggiunto!');
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

    // Ignora le scorciatoie mentre si digita in un campo di testo (ricerca, input…)
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

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
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      // Undo spostamenti con frecce / drag / gruppi (sessione corrente)
      e.preventDefault();
      this.undoMove();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // Sposta il nodo selezionato con le frecce (Shift = passo grande).
      // v1.9.4: anche la radice è spostabile con le frecce.
      if (this.selectedNodeId && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const step = e.shiftKey ? 32 : 8;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        this.moveSelectedBy(dx, dy);
      }
    }
  }

  // Sposta con le frecce il nodo selezionato (+ i suoi discendenti, o il gruppo
  // multi-selezione) e salva le posizioni custom come per il drag col mouse.
  moveSelectedBy(dx, dy) {
    const ids = this.selectedNodeIds && this.selectedNodeIds.size > 1 ? Array.from(this.selectedNodeIds) : (this.selectedNodeId ? [this.selectedNodeId] : []);
    if (!ids.length) return;

    // Cronologia per Ctrl+Z: snapshot delle posizioni PRIMA dello spostamento
    // (nodi selezionati + tutti i discendenti che verranno spostati con loro).
    const historyIds = new Set();
    for (const id of ids) {
      const hn = this.renderedNodes.find(item => item.id === id);
      if (!hn) continue;
      historyIds.add(hn.id);
      for (const d of this.collectDescendants(hn)) historyIds.add(d.node.id);
    }
    const snapshot = [];
    for (const hid of historyIds) {
      const hn = this.renderedNodes.find(item => item.id === hid);
      if (hn) snapshot.push({ id: hn.id, x: hn.x, y: hn.y });
    }
    this.pushMoveHistory(snapshot);

    const moved = new Set();
    const apply = (n) => {
      const raw = this.findRawNode(n.id);
      if (raw && moved.has(raw)) return;
      n.x = Math.round(n.x + dx);
      n.y = Math.round(n.y + dy);
      const el = this.nodesLayer.querySelector(`[data-id="${n.id}"]`) || this.nodesLayer.querySelector(`[data-node-id="${n.id}"]`);
      if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
      if (raw) { raw.customX = n.x; raw.customY = n.y; moved.add(raw); }
      for (const d of this.collectDescendants(n)) {
        if (d.rawNode && moved.has(d.rawNode)) continue;
        d.node.x = Math.round(d.node.x + dx);
        d.node.y = Math.round(d.node.y + dy);
        const el2 = this.nodesLayer.querySelector(`[data-id="${d.node.id}"]`) || this.nodesLayer.querySelector(`[data-node-id="${d.node.id}"]`);
        if (el2) { el2.style.left = `${d.node.x}px`; el2.style.top = `${d.node.y}px`; }
        if (d.rawNode) { d.rawNode.customX = d.node.x; d.rawNode.customY = d.node.y; moved.add(d.rawNode); }
      }
    };
    for (const id of ids) {
      const n = this.renderedNodes.find(item => item.id === id);
      if (n) apply(n);
    }
    this.updateBranchPathsRealtime();
    this.updateGroupsRealtime();
    this.renderEdgeControls();
    this.saveLayoutMemory();
  }

  onMouseDown(e) {
    if (e.target.closest('.cds-mm-node') || e.target.closest('.cds-mm-top-dock') || e.target.closest('.cds-mm-floating-bar') || e.target.closest('.cds-mm-minimap') || e.target.closest('.cds-mm-edge-add-btn') || e.target.closest('.cds-mm-group-header') || e.target.closest('.cds-mm-multi-toolbar')) return;
    
    // Se premuto tasto sinistro con Shift, avvia Selezione Rettangolare (Marquee / Lasso)
    if (e.button === 0 && e.shiftKey) {
      this.isMarquee = true;
      const rect = this.stage.getBoundingClientRect();
      const startX = (e.clientX - rect.left) / this.zoom;
      const startY = (e.clientY - rect.top) / this.zoom;
      this.marqueeStart = { x: startX, y: startY, clientX: e.clientX, clientY: e.clientY };
      if (!this.marqueeEl) {
        this.marqueeEl = this.stage.createDiv({ cls: 'cds-mm-marquee-box' });
      }
      this.marqueeEl.style.display = 'block';
      this.marqueeEl.style.left = `${startX}px`;
      this.marqueeEl.style.top = `${startY}px`;
      this.marqueeEl.style.width = '0px';
      this.marqueeEl.style.height = '0px';
      return;
    }

    // Cliccando sullo sfondo vuoto senza Shift deseleziona tutto
    if (this.selectedNodeId || (this.selectedNodeIds && this.selectedNodeIds.size > 0)) {
      this.selectedNodeIds.clear();
      this.selectedNodeId = null;
      this.deselectAll();
      this.updateSelectionVisuals();
      this.updateMultiSelectToolbar();
    }

    this.isDraggingCanvas = true;
    this.viewport.addClass('is-dragging');
    this.dragStart = { x: e.clientX - this.panX, y: e.clientY - this.panY };
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = this.viewport.getBoundingClientRect();
      // Zoom verso il punto sotto il CURSORE (non verso l'origine della scena)
      this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, this.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
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

  // Applica lo zoom mantenendo fisso il punto della viewport (cx, cy): il punto
  // della scena sotto il cursore resta sotto il cursore durante lo zoom.
  zoomAt(cx, cy, val) {
    const z = this.zoom || 1;
    const newZoom = Math.max(0.2, Math.min(3.0, val));
    const sx = (cx - this.panX) / z;
    const sy = (cy - this.panY) / z;
    this.zoom = newZoom;
    this.panX = cx - sx * this.zoom;
    this.panY = cy - sy * this.zoom;
    this.updateTransform();
    this.updateMinimap();
  }

  setZoom(val) {
    // Ancoraggio predefinito: centro della viewport
    const vW = this.viewport.clientWidth || 1000;
    const vH = this.viewport.clientHeight || 700;
    this.zoomAt(vW / 2, vH / 2, val);
  }

  centerRoot() {
    const vW = this.viewport.clientWidth || 1000;
    const vH = this.viewport.clientHeight || 700;
    // Usa il nodo root RENDERIZZATO (posizioni reali del layout, non lo snapshot grezzo)
    const root = (this.renderedNodes && this.renderedNodes.find(n => n.isRoot)) || this.rawRootNode;
    const rx = (root && typeof root.x === 'number') ? root.x : 1200;
    const ry = (root && typeof root.y === 'number') ? root.y : 600;
    const rw = (root && root.width) || 220;
    const rh = (root && root.height) || 60;

    // Ordine corretto: prima lo zoom, poi il pan che DEVE moltiplicare per lo zoom
    this.zoom = 0.9;
    this.panX = Math.round((vW / 2) - (rx + rw / 2) * this.zoom);
    this.panY = Math.round((vH / 2) - (ry + rh / 2) * this.zoom);
    this.updateTransform();
    this.updateMinimap();
  }

  centerOnNode(node) {
    if (!node) return;
    const vW = this.viewport.clientWidth || 1000;
    const vH = this.viewport.clientHeight || 700;
    const nodeX = node.x || 0;
    const nodeY = node.y || 0;
    const nodeW = node.width || 180;
    const nodeH = node.height || 50;

    this.panX = (vW / 2) - (nodeX + (nodeW / 2)) * this.zoom;
    this.panY = (vH / 2) - (nodeY + (nodeH / 2)) * this.zoom;
    this.updateTransform();
    this.updateMinimap();
  }

  applyTheme() {
    if (!this.container) return;
    this.container.classList.remove('theme-dark', 'theme-blueprint', 'theme-light');
    this.container.classList.add(`theme-${this.theme}`);
  }

  cycleNodeColor(node) {
    const colors = [
      '#38bdf8', // Celeste Sky
      '#10b981', // Smeraldo Emerald
      '#fbbf24', // Ambra Amber
      '#f43f5e', // Corallo Rose
      '#a855f7', // Viola Purple
      null       // Default
    ];
    const current = node.customColor || null;
    const nextIdx = (colors.indexOf(current) + 1) % colors.length;
    const nextColor = colors[nextIdx];
    
    node.customColor = nextColor;
    const raw = this.findRawNode(node.id);
    if (raw) raw.customColor = nextColor;
    
    this.saveLayoutMemory();
    this.render();
    new Notice('🎨 Colore nodo aggiornato');
  }

  openImageLightbox(src, caption = '') {
    const overlay = document.createElement('div');
    overlay.className = 'cds-mm-lightbox-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.88);backdrop-filter:blur(8px);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;cursor:zoom-out;';

    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'max-width:90vw;max-height:82vh;object-fit:contain;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.8);border:2px solid rgba(255,255,255,0.2);cursor:default;';
    img.onclick = (e) => e.stopPropagation();

    if (caption) {
      const capEl = document.createElement('div');
      capEl.textContent = caption;
      capEl.style.cssText = 'color:#f8fafc;font-size:0.95rem;font-weight:600;margin-top:12px;text-align:center;max-width:800px;';
      overlay.appendChild(capEl);
    }

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕ Chiudi';
    closeBtn.style.cssText = 'position:absolute;top:20px;right:24px;background:rgba(255,255,255,0.15);color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-weight:700;font-size:0.9rem;';
    closeBtn.onclick = () => overlay.remove();

    overlay.appendChild(img);
    overlay.appendChild(closeBtn);
    overlay.onclick = () => overlay.remove();

    const onEsc = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        window.removeEventListener('keydown', onEsc);
      }
    };
    window.addEventListener('keydown', onEsc);

    document.body.appendChild(overlay);
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

    if (this.plugin && this.plugin.settings && this.plugin.settings.fileLayouts) {
      const saved = this.plugin.settings.fileLayouts[this.file.path];
      if (saved) {
        CUSTOM_POSITIONS_CACHE.set(this.file.path + '_layout', saved);
        if (saved.positions) {
          CUSTOM_POSITIONS_CACHE.set(this.file.path, saved.positions);
        }
      }
    }

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

    let saved = null;
    if (this.plugin && this.plugin.settings && this.plugin.settings.fileLayouts) {
      saved = this.plugin.settings.fileLayouts[this.file.path];
      if (saved) {
        CUSTOM_POSITIONS_CACHE.set(this.file.path + '_layout', saved);
        if (saved.positions) {
          CUSTOM_POSITIONS_CACHE.set(this.file.path, saved.positions);
        }
      }
    }

    const content = await this.app.vault.read(this.file);
    const newRoot = MindmapEngine.parseMarkdown(content, this.file.basename, this.file.path);

    const prevSelectedId = this.canvas.selectedNodeId;
    this.canvas.rawRootNode = newRoot;
    if (saved) {
      this.canvas.applySavedLayout(saved);
    }
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
    console.log('Loading CDS Mindmap Suite v1.8.9 (Pure Balanced Bilateral Layout & Zero-Click Obsidian Canvas) (Compact Printable Layout, Clean Connections & Native Canvas)');

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

        // Sincronizzazione Canvas nativo di Obsidian: elimina nodi vuoti a qualsiasi livello di zoom
    const ensureCanvasNodesLoaded = (canvas) => {
      if (!canvas) return;
      try {
        if (!canvas.options) canvas.options = {};
        canvas.options.zoomBreakpoint = 9999;
        if (canvas.nodes) {
          canvas.nodes.forEach(node => {
            node.alwaysKeepLoaded = true;
            if (node.initialized && !node.isContentMounted && typeof node.mountContent === 'function') {
              node.mountContent();
            }
          });
        }
      } catch (e) {}
    };

    const handleCanvasLeaf = (leaf) => {
      if (!leaf || !leaf.view) return;
      const canvas = leaf.view.canvas;
      if (canvas) {
        ensureCanvasNodesLoaded(canvas);
        setTimeout(() => ensureCanvasNodesLoaded(canvas), 80);
        setTimeout(() => ensureCanvasNodesLoaded(canvas), 350);
      }
    };

    this.registerEvent(this.app.workspace.on('active-leaf-change', handleCanvasLeaf));
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      try {
        const leaves = this.app.workspace.getLeavesOfType('canvas');
        for (const leaf of leaves) handleCanvasLeaf(leaf);
      } catch (e) {}
    }));

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
      id: 'export-active-note-to-canvas',
      name: 'Esporta e apri nota attiva come Obsidian Canvas (.canvas)',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === 'md') {
          if (!checking) this.exportActiveNoteToCanvas(file);
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

  async exportActiveNoteToCanvas(file) {
    try {
      const activeFile = file || this.app.workspace.getActiveFile();
      if (!activeFile) {
        new Notice('Nessuna nota Markdown selezionata.');
        return;
      }
      const content = await this.app.vault.read(activeFile);
      const root = MindmapEngine.parseMarkdown(content, activeFile.basename, activeFile.path);
      const canvasData = MindmapEngine.exportToObsidianCanvas(root, {
        detailLevel: 'full',
        viewMode: 'bilateral'
      });

      const parentFolder = activeFile.parent ? activeFile.parent.path : '';
      const canvasPath = parentFolder ? `${parentFolder}/${activeFile.basename}.canvas` : `${activeFile.basename}.canvas`;
      const jsonStr = JSON.stringify(canvasData, null, 2);

      const existing = this.app.vault.getAbstractFileByPath(canvasPath);
      if (existing) {
        await this.app.vault.modify(existing, jsonStr);
      } else {
        await this.app.vault.create(canvasPath, jsonStr);
      }

      new Notice(`🗺️ Generato Obsidian Canvas: ${canvasPath}`);
      await this.app.workspace.openLinkText(canvasPath, '', true);
    } catch(err) {
      console.error('[CDS Mindmap] Error exporting to canvas:', err);
      new Notice(`⚠️ Errore creazione Canvas: ${err.message}`);
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
