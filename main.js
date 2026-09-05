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
// 1. MindmapEngine: Parser, Serializer & Layout Core
// ==========================================================================

class MindmapEngine {
  /**
   * Genera un ID univoco per il nodo
   */
  static genId() {
    return 'node_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Analizza una stringa Markdown e genera l'albero gerarchico dei nodi
   */
  static parseMarkdown(mdText, fallbackTitle = 'Mappa Concettuale') {
    if (!mdText || !mdText.trim()) {
      return {
        id: 'root',
        text: fallbackTitle,
        depth: 0,
        children: [],
        collapsed: false,
        isRoot: true
      };
    }

    // 1. Rimuovi frontmatter YAML
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
      children: [],
      collapsed: false,
      isRoot: true
    };

    let currentParentStack = [rootNode];
    let foundFirstHeading = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Analizza link PDF: [[Documento.pdf#page=5&rect=x,y,w,h|Testo]]
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
          children: [],
          collapsed: false,
          pdfLink
        };

        // Trova il genitore appropriato per questo livello
        while (currentParentStack.length > 1 && currentParentStack[currentParentStack.length - 1].depth >= level) {
          currentParentStack.pop();
        }

        const parent = currentParentStack[currentParentStack.length - 1];
        parent.children.push(node);
        currentParentStack.push(node);
        continue;
      }

      // Check List Item (- item, * item, + item, 1. item)
      const listMatch = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        const indent = listMatch[1].replace(/\t/g, '  ').length;
        const listLevel = (currentParentStack[currentParentStack.length - 1].depth || 1) + Math.floor(indent / 2) + 1;
        const text = listMatch[2].trim();

        const node = {
          id: MindmapEngine.genId(),
          text,
          depth: listLevel,
          children: [],
          collapsed: false,
          pdfLink
        };

        while (currentParentStack.length > 1 && currentParentStack[currentParentStack.length - 1].depth >= listLevel) {
          currentParentStack.pop();
        }

        const parent = currentParentStack[currentParentStack.length - 1];
        parent.children.push(node);
        currentParentStack.push(node);
        continue;
      }

      // Testo normale sotto un nodo (arricchisce il testo del nodo precedente)
      if (currentParentStack.length > 1) {
        const lastNode = currentParentStack[currentParentStack.length - 1];
        if (lastNode && !lastNode.isRoot) {
          lastNode.text += '\n' + trimmed;
        }
      }
    }

    return rootNode;
  }

  /**
   * Converte l'albero gerarchico in una stringa Markdown pulita
   */
  static serializeToMarkdown(rootNode, originalFm = '') {
    const lines = [];

    // Preserva il frontmatter o aggiungi la firma basic
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

    // Titolo radice
    lines.push(`# ${rootNode.text || 'Mappa Concettuale'}`);
    lines.push('');

    const walk = (node, depth) => {
      if (!node.children || !node.children.length) return;

      for (const child of node.children) {
        let nodeText = child.text || 'Nuovo Concetto';

        // Se ha link PDF serializza
        if (child.pdfLink && !nodeText.includes('.pdf')) {
          const p = child.pdfLink;
          const rectStr = p.rect ? `&rect=${p.rect.join(',')}` : '';
          nodeText += ` [[${p.file}#page=${p.page}${rectStr}|📄 Pag. ${p.page}]]`;
        }

        if (depth === 1) {
          lines.push(`## ${nodeText}`);
        } else if (depth === 2) {
          lines.push(`### ${nodeText}`);
        } else if (depth === 3) {
          lines.push(`#### ${nodeText}`);
        } else {
          const indent = '  '.repeat(depth - 4);
          lines.push(`${indent}- ${nodeText}`);
        }

        if (child.children && child.children.length) {
          walk(child, depth + 1);
        }
      }
    };

    walk(rootNode, 1);
    return lines.join('\n');
  }

  /**
   * Calcola le dimensioni e le coordinate di tutti i nodi e genera le curve Bezier
   */
  static computeLayout(rootNode, options = {}) {
    const layoutMode = options.mode || 'horizontal-right'; // 'horizontal-right', 'bilateral', 'outline'
    const horizontalGap = options.horizontalGap || 70;
    const verticalGap = options.verticalGap || 18;

    // 1. Assegna larghezza e altezza a ciascun nodo
    const measureNode = (node) => {
      const text = node.text || '';
      const lines = text.split('\n');
      const maxLineLen = lines.reduce((max, l) => Math.max(max, l.length), 0);
      
      node.width = Math.max(90, Math.min(340, maxLineLen * 8.8 + 32));
      node.height = Math.max(38, lines.length * 20 + 16 + (node.pdfLink ? 20 : 0));

      if (node.isRoot) {
        node.width = Math.max(120, maxLineLen * 10 + 40);
        node.height = Math.max(48, lines.length * 24 + 20);
      }

      if (node.children && node.children.length && !node.collapsed) {
        for (const child of node.children) {
          measureNode(child);
        }
      }
    };

    measureNode(rootNode);

    // 2. Calcola l'altezza di ogni sotto-albero
    const computeSubtreeHeight = (node) => {
      if (!node.children || !node.children.length || node.collapsed) {
        node.subtreeHeight = node.height + verticalGap;
        return node.subtreeHeight;
      }
      let sum = 0;
      for (const child of node.children) {
        sum += computeSubtreeHeight(child);
      }
      node.subtreeHeight = Math.max(node.height + verticalGap, sum);
      return node.subtreeHeight;
    };

    computeSubtreeHeight(rootNode);

    // 3. Posiziona i nodi nel canvas
    const renderedNodes = [];
    const branchPaths = [];

    rootNode.x = 80;
    rootNode.y = Math.max(200, (rootNode.subtreeHeight - rootNode.height) / 2);
    rootNode.color = '#38bdf8';
    renderedNodes.push(rootNode);

    const positionChildren = (parent, branchColor) => {
      if (!parent.children || !parent.children.length || parent.collapsed) return;

      let startY = parent.y + (parent.height / 2) - (parent.subtreeHeight / 2);

      for (let i = 0; i < parent.children.length; i++) {
        const child = parent.children[i];
        const color = branchColor || BRANCH_COLORS[i % BRANCH_COLORS.length];
        child.color = color;

        child.x = parent.x + parent.width + horizontalGap;
        child.y = startY + (child.subtreeHeight / 2) - (child.height / 2);
        startY += child.subtreeHeight;

        renderedNodes.push(child);

        // Genera curva Bezier cubica dal genitore al figlio
        const x1 = parent.x + parent.width;
        const y1 = parent.y + (parent.height / 2);
        const x2 = child.x;
        const y2 = child.y + (child.height / 2);
        const dx = (x2 - x1) * 0.55;

        const pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        branchPaths.push({
          d: pathD,
          color,
          fromId: parent.id,
          toId: child.id
        });

        positionChildren(child, color);
      }
    };

    if (rootNode.children && rootNode.children.length && !rootNode.collapsed) {
      let curY = rootNode.y + (rootNode.height / 2) - (rootNode.subtreeHeight / 2);

      for (let i = 0; i < rootNode.children.length; i++) {
        const child = rootNode.children[i];
        const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
        child.color = color;

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

        positionChildren(child, color);
      }
    }

    return { nodes: renderedNodes, paths: branchPaths, root: rootNode };
  }
}

// ==========================================================================
// 2. MindmapCanvas: Interfaccia Interattiva SVG, Drag&Drop & Editing
// ==========================================================================

class MindmapCanvas {
  constructor(containerEl, options = {}) {
    this.container = containerEl;
    this.options = options;
    this.rootNode = options.rootNode || { id: 'root', text: 'Mappa Concettuale', children: [], isRoot: true };
    this.selectedNodeId = 'root';
    this.panX = 40;
    this.panY = 40;
    this.zoom = 1;
    this.isDraggingCanvas = false;
    this.dragStart = { x: 0, y: 0 };
    this.draggingNode = null;
    this.editingNode = null;
    this.history = [];
    this.historyIndex = -1;

    this.initDOM();
    this.render();
  }

  initDOM() {
    this.container.empty();
    this.container.addClass('cds-mm-container');

    // 1. Toolbar superiore fluttuante
    this.toolbar = this.container.createDiv({ cls: 'cds-mm-toolbar' });
    this.renderToolbar();

    // 2. Viewport & Stage
    this.viewport = this.container.createDiv({ cls: 'cds-mm-viewport' });
    this.stage = this.viewport.createDiv({ cls: 'cds-mm-stage' });

    // SVG layer per le curve
    this.svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svgLayer.setAttribute('class', 'cds-mm-svg');
    this.stage.appendChild(this.svgLayer);

    // HTML layer per i nodi
    this.nodesLayer = this.stage.createDiv({ cls: 'cds-mm-nodes-layer' });

    // 3. Footer con guida tastiera
    this.footerGuide = this.container.createDiv({ cls: 'cds-mm-footer-guide' });
    this.footerGuide.innerHTML = `
      <span><kbd>Tab</kbd> Figlio</span>
      <span><kbd>Enter</kbd> Fratello</span>
      <span><kbd>Canc</kbd> Elimina</span>
      <span><kbd>F2 / Spazio</kbd> Modifica</span>
      <span><kbd>Ctrl+E</kbd> Centra</span>
    `;

    // Eventi Canvas Pan & Zoom
    this.viewport.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Eventi da Tastiera
    this.container.setAttribute('tabindex', '0');
    this.container.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  renderToolbar() {
    this.toolbar.empty();

    const mkBtn = (label, icon, title, onClick) => {
      const b = this.toolbar.createEl('button', { cls: 'cds-mm-btn', attr: { title } });
      b.innerHTML = `${icon} <span>${label}</span>`;
      b.onclick = onClick;
      return b;
    };

    mkBtn('', '➕', 'Aggiungi Nodo Figlio (Tab)', () => this.addChildToSelected());
    mkBtn('', '⏬', 'Aggiungi Fratello (Enter)', () => this.addSiblingToSelected());
    mkBtn('', '🗑️', 'Elimina Nodo (Canc)', () => this.deleteSelected());

    this.toolbar.createDiv({ cls: 'cds-mm-divider' });

    mkBtn('', '🔍+', 'Zoom In', () => this.setZoom(this.zoom * 1.15));
    mkBtn('', '🔍-', 'Zoom Out', () => this.setZoom(this.zoom / 1.15));
    mkBtn('100%', '🎯', 'Ripristina Zoom (100%)', () => { this.zoom = 1; this.updateTransform(); });
    mkBtn('', '🧭', 'Centra Radice (Ctrl+E)', () => this.centerRoot());

    this.toolbar.createDiv({ cls: 'cds-mm-divider' });

    mkBtn('', '🖼️ SVG', 'Esporta Immagine SVG', () => this.exportSVG());
    mkBtn('', '📷 PNG', 'Esporta Immagine PNG', () => this.exportPNG());

    if (this.options.onSaveMarkdown) {
      mkBtn('Salva', '💾', 'Salva Modifiche nella Nota', () => this.triggerSave());
    }
  }

  render() {
    const layout = MindmapEngine.computeLayout(this.rootNode);
    this.renderedNodes = layout.nodes;
    this.renderedPaths = layout.paths;

    // 1. Aggiorna Layer SVG
    while (this.svgLayer.firstChild) {
      this.svgLayer.removeChild(this.svgLayer.firstChild);
    }

    let minX = 0, minY = 0, maxX = 1200, maxY = 800;

    for (const p of this.renderedPaths) {
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', p.d);
      pathEl.setAttribute('stroke', p.color);
      pathEl.setAttribute('class', 'cds-mm-branch-path' + (p.toId === this.selectedNodeId ? ' is-selected' : ''));
      this.svgLayer.appendChild(pathEl);
    }

    // 2. Aggiorna Layer Nodi HTML
    this.nodesLayer.empty();

    for (const node of this.renderedNodes) {
      if (node.x + node.width > maxX) maxX = node.x + node.width + 100;
      if (node.y + node.height > maxY) maxY = node.y + node.height + 100;

      const nodeEl = this.nodesLayer.createDiv({
        cls: 'cds-mm-node' +
          (node.isRoot ? ' is-root' : ` level-${node.depth}`) +
          (node.id === this.selectedNodeId ? ' is-selected' : '')
      });

      nodeEl.style.left = `${node.x}px`;
      nodeEl.style.top = `${node.y}px`;
      nodeEl.style.width = `${node.width}px`;
      nodeEl.style.borderColor = node.isRoot ? 'rgba(255,255,255,0.4)' : node.color || '#38bdf8';

      // Contenuto testuale
      const textEl = nodeEl.createDiv({ cls: 'cds-mm-text' });
      textEl.textContent = node.text;

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

      // Pulsante Espandi / Riduci se ha figli
      if (node.children && node.children.length) {
        const foldBtn = nodeEl.createDiv({
          cls: 'cds-mm-fold-btn' + (node.collapsed ? ' is-collapsed' : '')
        });
        foldBtn.textContent = node.collapsed ? `+${node.children.length}` : '−';
        foldBtn.onclick = (ev) => {
          ev.stopPropagation();
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

      // Click e doppio click
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

    this.svgLayer.setAttribute('width', `${maxX + 300}`);
    this.svgLayer.setAttribute('height', `${maxY + 300}`);
    this.stage.style.width = `${maxX + 300}px`;
    this.stage.style.height = `${maxY + 300}px`;

    this.updateTransform();
  }

  updateTransform() {
    this.stage.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  setZoom(val) {
    this.zoom = Math.max(0.25, Math.min(3.0, val));
    this.updateTransform();
  }

  centerRoot() {
    const vW = this.viewport.clientWidth;
    const vH = this.viewport.clientHeight;
    this.panX = Math.max(60, vW * 0.12);
    this.panY = Math.max(60, (vH / 2) - (this.rootNode.height / 2) - 100);
    this.zoom = 1;
    this.updateTransform();
  }

  selectNode(nodeId) {
    this.selectedNodeId = nodeId;
    this.render();
  }

  findNode(nodeId, node = this.rootNode) {
    if (node.id === nodeId) return node;
    if (node.children) {
      for (const child of node.children) {
        const res = this.findNode(nodeId, child);
        if (res) return res;
      }
    }
    return null;
  }

  findParent(nodeId, current = this.rootNode) {
    if (!current.children) return null;
    for (const child of current.children) {
      if (child.id === nodeId) return current;
      const res = this.findParent(nodeId, child);
      if (res) return res;
    }
    return null;
  }

  addChildToSelected(defaultText = 'Nuovo Concetto', pdfLink = null) {
    const parent = this.findNode(this.selectedNodeId) || this.rootNode;
    parent.collapsed = false;
    const newNode = {
      id: MindmapEngine.genId(),
      text: defaultText,
      depth: (parent.depth || 0) + 1,
      children: [],
      collapsed: false,
      pdfLink
    };
    parent.children.push(newNode);
    this.selectedNodeId = newNode.id;
    this.render();
    this.triggerSave();

    // Entra subito in modalità modifica se appena creato
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
      children: [],
      collapsed: false
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
      const node = this.findNode(this.selectedNodeId);
      const nodeEl = this.nodesLayer.querySelector('.cds-mm-node.is-selected');
      if (node && nodeEl) this.startEditing(node, nodeEl);
    } else if (e.key === 'e' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.centerRoot();
    }
  }

  onMouseDown(e) {
    if (e.target.closest('.cds-mm-node') || e.target.closest('.cds-mm-toolbar')) return;
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

  startNodeDrag(node, ev) {
    // Implementazione del drag & drop per riordinare o cambiare genitore
    const ghost = ev.target.closest('.cds-mm-node');
    if (!ghost) return;

    ghost.addClass('is-ghost');
    let targetParent = null;

    const onMove = (me) => {
      const els = document.elementsFromPoint(me.clientX, me.clientY);
      const hoverNodeEl = els.find(el => el.classList && el.classList.contains('cds-mm-node') && el !== ghost);
      if (hoverNodeEl) {
        document.querySelectorAll('.cds-mm-node.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
        hoverNodeEl.classList.add('is-drop-target');
        targetParent = this.renderedNodes.find(n => hoverNodeEl.textContent.includes(n.text));
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      ghost.removeClass('is-ghost');
      document.querySelectorAll('.cds-mm-node.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));

      if (targetParent && targetParent.id !== node.id) {
        const oldParent = this.findParent(node.id);
        if (oldParent && oldParent.id !== targetParent.id) {
          // Rimuovi dal vecchio genitore e aggancia al nuovo
          oldParent.children = oldParent.children.filter(c => c.id !== node.id);
          node.depth = targetParent.depth + 1;
          targetParent.children.push(node);
          targetParent.collapsed = false;
          this.render();
          this.triggerSave();
          new Notice(`Spostato "${node.text.slice(0, 20)}" sotto "${targetParent.text.slice(0, 20)}"`);
        }
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  triggerSave() {
    if (this.options.onSaveMarkdown) {
      const md = MindmapEngine.serializeToMarkdown(this.rootNode, this.options.frontmatter);
      this.options.onSaveMarkdown(md);
    }
  }

  exportSVG() {
    const clone = this.svgLayer.cloneNode(true);
    clone.style.background = '#0f121d';
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(clone);
    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.rootNode.text || 'mindmap'}.svg`;
    a.click();
    URL.revokeObjectURL(url);
    new Notice('✅ Mappa esportata come SVG!');
  }

  exportPNG() {
    const clone = this.svgLayer.cloneNode(true);
    clone.style.background = '#0f121d';
    const svgStr = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = parseInt(this.svgLayer.getAttribute('width') || '1200', 10);
      canvas.height = parseInt(this.svgLayer.getAttribute('height') || '800', 10);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f121d';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      canvas.toBlob((blob) => {
        const pngUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = pngUrl;
        a.download = `${this.rootNode.text || 'mindmap'}.png`;
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
// 3. CdsMindmapView: Obsidian Leaf View per Note Intere
// ==========================================================================

class CdsMindmapView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null;
    this.canvas = null;
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
          await this.app.vault.modify(this.file, newMd);
        }
      },
      onPdfJump: (pdfLink) => {
        this.plugin.jumpToPdfAnnotation(pdfLink);
      }
    });

    this.canvas.centerRoot();
  }

  async onOpen() {
    // Se c'è un file attivo apri quello
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === 'md') {
      await this.setFile(activeFile);
    }
  }
}

// ==========================================================================
// 4. CdsMindmapPlugin: Lifecycle, Comandi, Ribbon & Codeblock
// ==========================================================================

module.exports = class CdsMindmapPlugin extends Plugin {
  async onload() {
    console.log('Loading CDS Mindmap & Mappe Concettuali plugin');

    // 1. Registra Vista Nativa
    this.registerView(VIEW_TYPE_MINDMAP, (leaf) => new CdsMindmapView(leaf, this));

    // 2. Ribbon Icon
    this.addRibbonIcon('git-fork', 'CDS Mindmap: Apri come Mappa Concettuale', () => {
      this.openActiveNoteAsMindmap();
    });

    // 3. Comandi
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

    // 4. Codeblock Processor: ```mindmap ... ``` e ```markmind ... ```
    const codeblockHandler = (source, el, ctx) => {
      el.empty();
      const wrap = el.createDiv({ cls: 'cds-mm-codeblock' });
      const rootNode = MindmapEngine.parseMarkdown(source, 'Mappa Concettuale');

      new MindmapCanvas(wrap, {
        rootNode,
        onSaveMarkdown: async (newMd) => {
          // Se siamo all'interno di una nota, aggiorna il codeblock
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

    // 5. Pulsante nella barra superiore delle note Markdown per passare a Mappa
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

  /**
   * Salto bidirezionale verso la coordinata/pagina esatta del PDF in cds-docs o Obsidian
   */
  async jumpToPdfAnnotation(pdfLink) {
    if (!pdfLink || !pdfLink.file) return;

    // Cerca il file PDF nel vault
    const file = this.app.metadataCache.getFirstLinkpathDest(pdfLink.file, '');
    if (!file) {
      new Notice(`Documento PDF non trovato nel vault: ${pdfLink.file}`);
      return;
    }

    new Notice(`Salto a ${file.name} (Pag. ${pdfLink.page})...`);

    // Prova ad aprire con la vista CDS Docs
    const docsPlugin = this.app.plugins.getPlugin('cds-docs');
    if (docsPlugin && docsPlugin.openPdfFile) {
      docsPlugin.openPdfFile(file, pdfLink.page, pdfLink.rect);
      return;
    }

    // Fallback visualizzatore nativo Obsidian
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);

    // Naviga alla pagina se supportato dallo stato
    const state = leaf.getViewState();
    if (state && state.state) {
      state.state.page = pdfLink.page;
      await leaf.setViewState(state);
    }
  }

  onunload() {
    console.log('Unloading CDS Mindmap');
  }
};
