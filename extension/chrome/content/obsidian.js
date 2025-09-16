'use strict';

var { Services } = ChromeUtils.import('resource://gre/modules/Services.jsm');
var { OS } = ChromeUtils.import('resource://gre/modules/osfile.jsm');

const { classes: Cc, interfaces: Ci } = Components;

const PREF_BRANCH = 'extensions.zotero.obsidianDaily.';
const PREF_VAULT_PATH = PREF_BRANCH + 'vaultPath';
const PREF_DAILY_FOLDER = PREF_BRANCH + 'dailyFolder';
const PREF_FILENAME_TEMPLATE = PREF_BRANCH + 'fileNameTemplate';
const PREF_AUTO_EXPORT = PREF_BRANCH + 'autoExport';
const PREF_LAST_EXPORT = PREF_BRANCH + 'lastExportDate';

const DEFAULT_FILENAME_TEMPLATE = 'YYYY-MM-DD';
const BLOCK_MARK_PREFIX = 'zotero-obsidian-daily';

(function () {
  class ObsidianDailyExporter {
    constructor() {
      this._windowListener = {
        observe: (subject, topic) => {
          if (topic !== 'domwindowopened') {
            return;
          }
          const win = subject;
          win.addEventListener(
            'load',
            () => {
              try {
                if (this._isMainWindow(win)) {
                  this._injectWindow(win);
                }
              } catch (err) {
                Zotero.logError(err);
              }
            },
            { once: true }
          );
        },
      };
      this._windowData = new Map();
    }

    async startup() {
      await Zotero.initializationPromise;
      Services.obs.addObserver(this._windowListener, 'domwindowopened');

      const enumerator = Services.wm.getEnumerator('navigator:browser');
      while (enumerator.hasMoreElements()) {
        const win = enumerator.getNext();
        if (win.document.readyState === 'complete') {
          this._injectWindow(win);
        } else {
          win.addEventListener(
            'load',
            () => {
              try {
                this._injectWindow(win);
              } catch (err) {
                Zotero.logError(err);
              }
            },
            { once: true }
          );
        }
      }

      if (this._getAutoExportEnabled()) {
        this._maybeAutoExport().catch((err) => Zotero.logError(err));
      }
    }

    async shutdown() {
      try {
        Services.obs.removeObserver(this._windowListener, 'domwindowopened');
      } catch (err) {
        // ignore if already removed
      }

      for (const [win] of this._windowData) {
        this._teardownWindow(win);
      }
      this._windowData.clear();
    }

    _isMainWindow(win) {
      const doc = win?.document;
      if (!doc) {
        return false;
      }
      const root = doc.documentElement;
      const windowType = root?.getAttribute('windowtype');
      return windowType === 'navigator:browser';
    }

    _injectWindow(win) {
      if (!this._isMainWindow(win)) {
        return;
      }
      if (this._windowData.has(win)) {
        return;
      }

      const doc = win.document;
      const toolsPopup = doc.getElementById('menu_ToolsPopup') || doc.getElementById('menu_ToolsPopup_deck');
      if (!toolsPopup) {
        return;
      }

      const createXUL = (name) => doc.createXULElement(name);

      const rootMenu = createXUL('menu');
      rootMenu.id = 'obsidian-daily-menu';
      rootMenu.setAttribute('label', 'Obsidian 日记');

      const popup = createXUL('menupopup');
      rootMenu.appendChild(popup);

      const exportItem = createXUL('menuitem');
      exportItem.id = 'obsidian-daily-export-now';
      exportItem.setAttribute('label', '立即导出今日笔记');

      const configureItem = createXUL('menuitem');
      configureItem.id = 'obsidian-daily-configure';
      configureItem.setAttribute('label', '设置…');

      const autoItem = createXUL('menuitem');
      autoItem.id = 'obsidian-daily-auto-export';
      autoItem.setAttribute('label', '启动时自动导出');
      autoItem.setAttribute('type', 'checkbox');
      autoItem.setAttribute('checked', this._getAutoExportEnabled());

      const separator = createXUL('menuseparator');

      popup.appendChild(exportItem);
      popup.appendChild(configureItem);
      popup.appendChild(separator);
      popup.appendChild(autoItem);

      toolsPopup.appendChild(rootMenu);

      const onExport = () => {
        this._exportFromWindow(win).catch((err) => {
          this._reportError(win, err);
          Zotero.logError(err);
        });
      };

      const onConfigure = () => {
        this._showSettings(win).catch((err) => {
          this._reportError(win, err);
          Zotero.logError(err);
        });
      };

      const onToggle = () => {
        const newValue = !this._getAutoExportEnabled();
        this._setAutoExportEnabled(newValue);
        autoItem.setAttribute('checked', newValue);
      };

      exportItem.addEventListener('command', onExport);
      configureItem.addEventListener('command', onConfigure);
      autoItem.addEventListener('command', onToggle);

      const onUnload = () => {
        this._teardownWindow(win);
      };
      win.addEventListener('unload', onUnload, { once: true });

      this._windowData.set(win, {
        nodes: { rootMenu, exportItem, configureItem, autoItem },
        handlers: { onExport, onConfigure, onToggle, onUnload },
      });
    }

    _teardownWindow(win) {
      const data = this._windowData.get(win);
      if (!data) {
        return;
      }
      const { nodes, handlers } = data;
      try {
        if (nodes?.exportItem) {
          nodes.exportItem.removeEventListener('command', handlers.onExport);
        }
        if (nodes?.configureItem) {
          nodes.configureItem.removeEventListener('command', handlers.onConfigure);
        }
        if (nodes?.autoItem) {
          nodes.autoItem.removeEventListener('command', handlers.onToggle);
        }
        if (win && handlers.onUnload) {
          win.removeEventListener('unload', handlers.onUnload, { once: true });
        }
        if (nodes?.rootMenu?.parentElement) {
          nodes.rootMenu.parentElement.removeChild(nodes.rootMenu);
        }
      } catch (err) {
        Zotero.logError(err);
      }
      this._windowData.delete(win);
    }

    async _exportFromWindow(win) {
      const now = new Date();
      const result = await this._exportDaily(now, { notifyWindow: win, silent: false, mode: 'manual' });
      if (!result.hasData) {
        await this._inform(win, 'Obsidian 日记', '今天没有新的 Zotero 笔记或高亮。');
      }
    }

    async _maybeAutoExport() {
      try {
        const date = new Date();
        const todayKey = this._formatDateKey(date);
        const lastExport = Zotero.Prefs.get(PREF_LAST_EXPORT, true);
        if (lastExport === todayKey) {
          return;
        }
        const vault = this._getVaultPath();
        if (!vault) {
          return;
        }
        const result = await this._exportDaily(date, { notifyWindow: null, silent: true, mode: 'auto' });
        if (result.hasData) {
          Zotero.debug(`ObsidianDaily: auto exported ${result.notesCount} notes and ${result.annotationsCount} annotations.`);
        }
      } catch (err) {
        Zotero.logError(err);
      }
    }

    async _showSettings(win) {
      const selected = await this._pickVaultFolder(win);
      if (!selected) {
        return;
      }
      this._setVaultPath(selected);

      const folderObj = { value: this._getDailyFolder() };
      const folderAccepted = Services.prompt.prompt(
        win,
        'Obsidian 子目录',
        '请输入每日笔记在 Obsidian 库中的相对路径（可留空）:',
        folderObj,
        null,
        {}
      );
      if (folderAccepted) {
        this._setDailyFolder(folderObj.value.trim());
      }

      const templateObj = { value: this._getFileNameTemplate() };
      const templateAccepted = Services.prompt.prompt(
        win,
        '文件名模板',
        '使用 YYYY、MM、DD 作为日期占位符，例如 YYYY-MM-DD',
        templateObj,
        null,
        {}
      );
      if (templateAccepted) {
        const cleaned = templateObj.value.trim() || DEFAULT_FILENAME_TEMPLATE;
        this._setFileNameTemplate(cleaned);
      }

      await this._inform(win, 'Obsidian 日记', '设置已保存。');
    }

    async _pickVaultFolder(win) {
      const picker = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
      picker.init(win, '选择 Obsidian 库文件夹', Ci.nsIFilePicker.modeGetFolder);
      const current = this._getVaultPath();
      if (current) {
        try {
          const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
          file.initWithPath(current);
          picker.displayDirectory = file;
        } catch (err) {
          // ignore invalid stored path
        }
      }

      return await new Promise((resolve) => {
        picker.open((result) => {
          if (result === Ci.nsIFilePicker.returnOK && picker.file) {
            resolve(picker.file.path);
          } else {
            resolve(null);
          }
        });
      });
    }

    async _exportDaily(date, { notifyWindow, silent, mode }) {
      const range = this._getDayRange(date);
      const [notes, annotations] = await Promise.all([
        this._getNotes(range.startSQL, range.endSQL),
        this._getAnnotations(range.startSQL, range.endSQL),
      ]);

      if (!notes.length && !annotations.length) {
        return { hasData: false, notesCount: 0, annotationsCount: 0 };
      }

      const vaultPath = this._getVaultPath();
      if (!vaultPath) {
        if (!silent && notifyWindow) {
          await this._inform(notifyWindow, 'Obsidian 日记', '请先在设置中指定 Obsidian 库的路径。');
        }
        throw new Error('Obsidian vault path is not configured');
      }

      const targetPath = await this._ensureDailyNotePath(date);
      const blockBody = this._renderDailyBlock(date, notes, annotations);
      const writeResult = await this._writeDailyBlock(targetPath, date, blockBody);

      const dateKey = this._formatDateKey(date);
      Zotero.Prefs.set(PREF_LAST_EXPORT, dateKey, true);

      if (!silent && notifyWindow) {
        const summary = `已同步 ${notes.length} 条笔记、${annotations.length} 条高亮到\n${targetPath}`;
        await this._inform(
          notifyWindow,
          'Obsidian 日记',
          summary + (writeResult.updated ? '' : '\n（首次写入，已创建页面）')
        );
      }

      return {
        hasData: true,
        notesCount: notes.length,
        annotationsCount: annotations.length,
        targetPath,
      };
    }

    async _getNotes(startSQL, endSQL) {
      const typeID = await Zotero.ItemTypes.getID('note');
      const rows = await Zotero.DB.queryAsync(
        'SELECT itemID FROM items WHERE itemTypeID = ? AND dateAdded >= ? AND dateAdded < ?',
        [typeID, startSQL, endSQL]
      );
      if (!rows?.length) {
        return [];
      }

      const notes = [];
      for (const row of rows) {
        const item = await this._loadItem(row.itemID);
        if (!item || item.deleted) {
          continue;
        }
        const parent = item.parentItem || null;
        const parentTitle = parent?.getDisplayTitle?.() || '未关联条目';
        const parentURI = parent ? Zotero.URI.getItemURI(parent) : null;
        const title = (item.getNoteTitle?.() || '未命名笔记').trim();
        const contentHTML = item.getNote ? item.getNote() : '';
        const markdown = this._noteHTMLToMarkdown(contentHTML);
        const iso = Zotero.Date.sqlToISO8601(item.dateAdded);
        const time = this._formatTimeFromISO(iso);
        notes.push({
          id: item.id,
          title: title || '未命名笔记',
          markdown,
          parentTitle,
          parentURI,
          link: Zotero.URI.getItemURI(item),
          time,
        });
      }
      return notes;
    }

    async _getAnnotations(startSQL, endSQL) {
      const typeID = await Zotero.ItemTypes.getID('annotation');
      const rows = await Zotero.DB.queryAsync(
        'SELECT itemID FROM items WHERE itemTypeID = ? AND dateAdded >= ? AND dateAdded < ?',
        [typeID, startSQL, endSQL]
      );
      if (!rows?.length) {
        return [];
      }

      const annotations = [];
      for (const row of rows) {
        const item = await this._loadItem(row.itemID);
        if (!item || item.deleted) {
          continue;
        }
        const attachment = item.parentItem || null;
        const parent = attachment?.parentItem || attachment;
        const parentTitle = parent?.getDisplayTitle?.() || attachment?.getDisplayTitle?.() || '未知条目';
        const parentURI = parent ? Zotero.URI.getItemURI(parent) : attachment ? Zotero.URI.getItemURI(attachment) : null;
        const page = item.annotationPageLabel || '';
        const text = (item.annotationText || '').trim();
        const comment = (item.annotationComment || '').trim();
        const iso = Zotero.Date.sqlToISO8601(item.dateAdded);
        const time = this._formatTimeFromISO(iso);
        annotations.push({
          id: item.id,
          text,
          comment,
          page,
          parentTitle,
          parentURI,
          color: item.annotationColor || '',
          link: Zotero.URI.getItemURI(item),
          time,
        });
      }
      return annotations;
    }

    async _ensureDailyNotePath(date) {
      const vault = this._getVaultPath();
      if (!vault) {
        throw new Error('Obsidian vault path not configured');
      }
      const folder = this._getDailyFolder();
      const parts = folder
        ? folder
            .split(/[/\\]/)
            .map((part) => part.trim())
            .filter(Boolean)
        : [];
      const dir = parts.length ? OS.Path.join(vault, ...parts) : vault;
      if (dir !== vault) {
        await OS.File.makeDir(dir, { from: vault, ignoreExisting: true });
      }
      const baseName = this._buildDailyFileName(date);
      const fileName = baseName.endsWith('.md') ? baseName : `${baseName}.md`;
      return OS.Path.join(dir, fileName);
    }

    async _writeDailyBlock(targetPath, date, body) {
      const marker = this._getBlockMarkers(date);
      const block = `${marker.start}\n${body.trim()}\n${marker.end}`;
      let existing = '';
      let fileExists = true;
      try {
        existing = await OS.File.read(targetPath, { encoding: 'utf-8' });
      } catch (err) {
        if (err instanceof OS.File.Error && err.becauseNoSuchFile) {
          fileExists = false;
          existing = this._buildNewFileHeader(date);
        } else {
          throw err;
        }
      }

      const pattern = new RegExp(
        `${this._escapeRegExp(marker.start)}[\\s\\S]*?${this._escapeRegExp(marker.end)}`,
        'm'
      );

      let updated;
      if (pattern.test(existing)) {
        updated = existing.replace(pattern, block);
      } else if (!existing.trim()) {
        updated = `${block}\n`;
      } else {
        const trimmed = existing.replace(/\s*$/, '');
        updated = `${trimmed}\n\n${block}\n`;
      }

      await OS.File.writeAtomic(targetPath, updated, { encoding: 'utf-8' });
      return { updated: fileExists };
    }

    _renderDailyBlock(date, notes, annotations) {
      const dateLabel = this._formatDateKey(date);
      const lines = [];
      lines.push(`## 📥 Zotero 导入（${dateLabel}）`);
      lines.push(`> 同步时间：${this._formatDisplayTimestamp(new Date())}`);
      lines.push('');

      if (notes.length) {
        lines.push('### ✏️ 笔记');
        lines.push('');
        for (const group of this._groupByParent(notes)) {
          lines.push(this._renderGroupHeading(group));
          for (const note of group.items) {
            const label = note.link
              ? `[${this._escapeLinkText(note.title)}](${note.link})`
              : this._escapeMarkdownText(note.title);
            const heading = `- **${label}**（${note.time || '未知时间'}）`;
            lines.push(heading);
            if (note.markdown) {
              lines.push(this._indentMarkdown(note.markdown));
            } else {
              lines.push(this._indentMarkdown('（无正文）'));
            }
            lines.push('');
          }
        }
      }

      if (annotations.length) {
        lines.push('### 🔖 高亮');
        lines.push('');
        for (const group of this._groupByParent(annotations)) {
          lines.push(this._renderGroupHeading(group));
          for (const ann of group.items) {
            const label = ann.link ? `[高亮](${ann.link})` : '高亮';
            const parts = [];
            if (ann.page) {
              parts.push(`第 ${ann.page} 页`);
            }
            if (ann.time) {
              parts.push(ann.time);
            }
            const meta = parts.length ? `（${parts.join(' · ')}）` : '';
            lines.push(`- ${label}${meta}`);
            if (ann.text) {
              lines.push(this._indentMarkdown(this._formatBlockQuote(ann.text)));
            }
            if (ann.comment) {
              lines.push(this._indentMarkdown(this._formatBlockQuote(`💬 ${ann.comment}`)));
            }
            if (!ann.text && !ann.comment) {
              lines.push(this._indentMarkdown(this._formatBlockQuote('（无内容）')));
            }
            lines.push('');
          }
        }
      }

      return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    }

    _renderGroupHeading(group) {
      const title = this._escapeMarkdownText(group.title || '未关联条目');
      if (group.uri) {
        return `#### [${title}](${group.uri})`;
      }
      return `#### ${title}`;
    }

    _groupByParent(items) {
      const map = new Map();
      for (const item of items) {
        const key = item.parentURI || '__orphans__';
        const title = item.parentTitle || '未关联条目';
        if (!map.has(key)) {
          map.set(key, { title, uri: item.parentURI, items: [] });
        }
        map.get(key).items.push(item);
      }
      return Array.from(map.values());
    }

    _indentMarkdown(text) {
      const indent = '  ';
      if (!text) {
        return indent;
      }
      return text
        .split(/\r?\n/)
        .map((line) => indent + line)
        .join('\n');
    }

    _noteHTMLToMarkdown(html) {
      if (!html) {
        return '';
      }
      const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
      const serializeNode = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.nodeValue.replace(/\s+/g, ' ');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return '';
        }
        const tag = node.tagName.toLowerCase();
        const children = Array.from(node.childNodes).map((child) => serializeNode(child)).join('');
        switch (tag) {
          case 'br':
            return '\n';
          case 'p':
            return `${children.trim()}\n\n`;
          case 'ul': {
            const items = Array.from(node.children)
              .map((li) => `- ${serializeNode(li).trim()}`)
              .join('\n');
            return `${items}\n\n`;
          }
          case 'ol': {
            let index = 1;
            const items = Array.from(node.children)
              .map((li) => `${index++}. ${serializeNode(li).trim()}`)
              .join('\n');
            return `${items}\n\n`;
          }
          case 'li':
            return children.trim();
          case 'strong':
          case 'b':
            return `**${children.trim()}**`;
          case 'em':
          case 'i':
            return `_${children.trim()}_`;
          case 'code':
            return `\`${children.trim()}\``;
          case 'a': {
            const href = node.getAttribute('href');
            const text = children.trim() || href;
            return href ? `[${this._escapeLinkText(text)}](${href})` : text;
          }
          default:
            return children;
        }
      };
      const result = Array.from(doc.body.childNodes).map((child) => serializeNode(child)).join('');
      return result
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s+\n/g, '\n')
        .replace(/\n\s+/g, '\n')
        .trim();
    }

    _getBlockMarkers(date) {
      const key = this._formatDateKey(date);
      return {
        start: `<!-- ${BLOCK_MARK_PREFIX}:${key}:start -->`,
        end: `<!-- ${BLOCK_MARK_PREFIX}:${key}:end -->`,
      };
    }

    _escapeRegExp(value) {
      return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    _buildDailyFileName(date) {
      const template = this._getFileNameTemplate();
      const replacements = {
        YYYY: date.getFullYear().toString(),
        MM: this._pad2(date.getMonth() + 1),
        DD: this._pad2(date.getDate()),
      };
      return template.replace(/YYYY|MM|DD/g, (match) => replacements[match] || match);
    }

    _buildNewFileHeader(date) {
      const title = this._formatDateKey(date);
      return `# ${title}\n\n`;
    }

    _formatDateKey(date) {
      return `${date.getFullYear()}-${this._pad2(date.getMonth() + 1)}-${this._pad2(date.getDate())}`;
    }

    _formatTimeFromISO(isoString) {
      if (!isoString) {
        return '';
      }
      const date = new Date(isoString);
      if (Number.isNaN(date.getTime())) {
        return '';
      }
      return `${this._pad2(date.getHours())}:${this._pad2(date.getMinutes())}`;
    }

    _formatDisplayTimestamp(date) {
      return `${this._formatDateKey(date)} ${this._pad2(date.getHours())}:${this._pad2(date.getMinutes())}`;
    }

    _pad2(num) {
      return num.toString().padStart(2, '0');
    }

    _getDayRange(date) {
      const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
      const end = new Date(start.getTime());
      end.setDate(end.getDate() + 1);
      return {
        startSQL: this._toSQLDateTime(start),
        endSQL: this._toSQLDateTime(end),
      };
    }

    _toSQLDateTime(date) {
      return `${date.getFullYear()}-${this._pad2(date.getMonth() + 1)}-${this._pad2(date.getDate())} ${this._pad2(
        date.getHours()
      )}:${this._pad2(date.getMinutes())}:${this._pad2(date.getSeconds())}`;
    }

    _getVaultPath() {
      const value = Zotero.Prefs.get(PREF_VAULT_PATH, true);
      return value ? value.trim() : '';
    }

    _setVaultPath(path) {
      Zotero.Prefs.set(PREF_VAULT_PATH, path || '', true);
    }

    _getDailyFolder() {
      const value = Zotero.Prefs.get(PREF_DAILY_FOLDER, true);
      return value ? value.trim() : '';
    }

    _setDailyFolder(folder) {
      Zotero.Prefs.set(PREF_DAILY_FOLDER, folder || '', true);
    }

    _getFileNameTemplate() {
      return (Zotero.Prefs.get(PREF_FILENAME_TEMPLATE, true) || DEFAULT_FILENAME_TEMPLATE).trim();
    }

    _setFileNameTemplate(template) {
      Zotero.Prefs.set(PREF_FILENAME_TEMPLATE, template || DEFAULT_FILENAME_TEMPLATE, true);
    }

    _getAutoExportEnabled() {
      const pref = Zotero.Prefs.get(PREF_AUTO_EXPORT, true);
      if (pref === null || pref === undefined) {
        return true;
      }
      return !!pref;
    }

    _setAutoExportEnabled(value) {
      Zotero.Prefs.set(PREF_AUTO_EXPORT, !!value, true);
    }

    _formatBlockQuote(text) {
      return text
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join('\n');
    }

    async _loadItem(id) {
      try {
        if (typeof Zotero.Items.getAsync === 'function') {
          return await Zotero.Items.getAsync(id);
        }
        return Zotero.Items.get(id);
      } catch (err) {
        Zotero.logError(err);
        return null;
      }
    }

    _escapeMarkdownText(text) {
      if (!text) {
        return '';
      }
      return text.replace(/[\\*_`\[\]\(\)]/g, '\\$&');
    }

    _escapeLinkText(text) {
      if (!text) {
        return '';
      }
      return text.replace(/[\[\]]/g, '\\$&');
    }

    async _inform(win, title, message) {
      return Zotero.alert(win, title, message);
    }

    _reportError(win, error) {
      const message = error?.message || String(error);
      Zotero.alert(win, 'Obsidian 日记', `操作失败：${message}`);
    }
  }

  Zotero.ObsidianDailyExporter = ObsidianDailyExporter;
})();
