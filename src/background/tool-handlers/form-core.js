/**
 * Form input tool handler
 * Supports native <select>, custom dropdowns (React Select, MUI, Workday), and all standard inputs.
 *
 * Two element resolution paths:
 * - CDP backendNodeId (numeric refs from read_page): resolved via DOM.resolveNode
 * - Legacy ref_N (from content script find): resolved via WeakRef in content script
 */

import { ensureDebugger, sendDebuggerCommand } from '../managers/debugger-manager.js';
import { createElementResolver } from '../dom-service/element-resolver.js';

const elementResolver = createElementResolver(sendDebuggerCommand);

/**
 * The form manipulation function body.
 * Runs in page context via Runtime.callFunctionOn (CDP path).
 * First argument is the element (resolved from objectId), second is the value.
 */
const FORM_MANIPULATION_FN = `async (el, value) => {
  try {
    if (!el || !document.contains(el)) {
      return { error: 'Element has been removed from the page.' };
    }
    if (!(el instanceof Element)) {
      return { error: 'Reference resolved to a non-element node (type: ' + el.nodeType + '). Use read_page to get a valid element ref.' };
    }

    if (el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });

    const normalizeText = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const fieldLabelFor = (node) => {
      const parts = [];
      const add = (v) => { v = String(v || '').trim(); if (v) parts.push(v); };
      add(node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.getAttribute('name')));
      if (node.id && window.CSS && CSS.escape) {
        add(document.querySelector('label[for="' + CSS.escape(node.id) + '"]')?.textContent);
      }
      let n = node;
      for (let i = 0; i < 7 && n; i++, n = n.parentElement) {
        add(n.querySelector?.('[data-automation-id="formFieldLabel"], [data-automation-id="promptOption"], label')?.textContent);
        const labelledBy = n.getAttribute && n.getAttribute('aria-labelledby');
        if (labelledBy && window.CSS && CSS.escape) {
          add(labelledBy.split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
        }
      }
      return parts.join(' ');
    };
    const fieldLabel = fieldLabelFor(el);
    const isWorkdayPage = /(^|\\.)myworkdayjobs\\.com$/i.test(location.hostname) ||
      /(^|\\.)myworkday\\.com$/i.test(location.hostname) ||
      !!document.querySelector('[data-automation-id="activeListContainer"], [data-automation-id="promptOption"], [data-automation-id="formFieldLabel"]');
    const fieldScopeFor = (node) => {
      let n = node;
      for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
        const txt = normalizeText(n.textContent || '');
        if (txt && normalizeText(fieldLabel) && txt.includes(normalizeText(fieldLabel).slice(0, 20))) return n;
        if (n.getAttribute && /formField|prompt|select|multiselect/i.test(n.getAttribute('data-automation-id') || '')) return n;
      }
      return node.parentElement || node;
    };

    // SELECT element (native)
    if (el instanceof HTMLSelectElement) {
      const prev = el.value;
      const options = Array.from(el.options);
      const valueStr = String(value);
      let found = false;
      for (let i = 0; i < options.length; i++) {
        if (options[i].value === valueStr || options[i].text === valueStr ||
            options[i].text.toLowerCase() === valueStr.toLowerCase()) {
          el.selectedIndex = i;
          found = true;
          break;
        }
      }
      if (!found) {
        return { error: 'Option "' + valueStr + '" not found. Available: ' +
          options.map(o => '"' + o.text + '" (value: "' + o.value + '")').join(', ') };
      }
      el.focus();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      return { output: 'Selected "' + valueStr + '" (previous: "' + prev + '")' };
    }

    // CUSTOM DROPDOWN / COMBOBOX
    const isCombobox = el.getAttribute('role') === 'combobox' ||
                       el.getAttribute('aria-autocomplete') === 'list';
    const comboboxAncestor = !isCombobox ? el.closest('[role="combobox"]') : null;
    const hasComboboxInput = !isCombobox && !comboboxAncestor && el.tagName !== 'INPUT'
      ? el.querySelector('input[role="combobox"], input[aria-autocomplete="list"]')
      : null;
    const haspopup = el.getAttribute('aria-haspopup');
    const isDropdownTrigger = !isCombobox && !comboboxAncestor && !hasComboboxInput &&
      (haspopup === 'listbox' || haspopup === 'true' ||
       el.getAttribute('role') === 'listbox' ||
       (el.tagName === 'BUTTON' && el.closest('[data-automation-id]') &&
        (el.querySelector('[data-automation-id*="select"]') || el.closest('[data-automation-id*="select"]') ||
         el.closest('[data-automation-id*="dropdown"]'))));
    const wdInput = el.tagName === 'INPUT' ? el : null;
    const wdAutomationId = wdInput ? (wdInput.getAttribute('data-automation-id') || '') : '';
    let wdContainerMatch = false;
    if (wdInput) {
      let n = wdInput.parentElement;
      for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
        const aid = (n.getAttribute && n.getAttribute('data-automation-id')) || '';
        const wt = (n.getAttribute && n.getAttribute('data-uxi-widget-type')) || '';
        if (wt === 'multiselect' || wt === 'selectinput' ||
            aid === 'multiSelectContainer' || aid === 'formField-skills' ||
            /multiselect|multiSelect|prompt|skills?$/i.test(aid)) {
          wdContainerMatch = true;
          break;
        }
        if (n.querySelector && n.querySelector(':scope > ul[data-automation-id="selectedItemList"], :scope > [data-automation-id="selectedItemList"]')) {
          wdContainerMatch = true;
          break;
        }
      }
    }
    const isWorkdayPromptInput = !isCombobox && !comboboxAncestor && !hasComboboxInput &&
      wdInput != null &&
      (wdInput.getAttribute('data-uxi-widget-type') === 'selectinput' ||
       (wdInput.getAttribute('data-uxi-element-id') || '').startsWith('selectinput-') ||
       wdAutomationId === 'searchBox' ||
       /^promptOption|^selectinput/i.test(wdInput.getAttribute('data-uxi-element-id') || '') ||
       wdContainerMatch);

    if (isCombobox || comboboxAncestor || hasComboboxInput || isDropdownTrigger || isWorkdayPromptInput) {
      let inp = null;
      let hasSearchInput = false;

      const requestedValue = String(value);
      let typedQuery = requestedValue;
      const labelNorm = normalizeText(fieldLabel);
      if (isWorkdayPage && /country phone code/.test(labelNorm) && /^(\\+?1|us|usa|united)$/.test(normalizeText(requestedValue))) {
        typedQuery = 'United';
      }

      // Workday leaves listboxes open after partial/failed selections. Starting a new
      // field while an old portal listbox is open causes options from two fields to mix
      // (e.g. "Linkedin" beside "Bahrain (+973)"). Close stale popups first.
      const openLists = Array.from(document.querySelectorAll('[data-automation-id="activeListContainer"], [role="listbox"]'))
        .filter(list => list.offsetParent !== null || list.getClientRects().length);
      if (isWorkdayPage && openLists.length && !openLists.some(list => list.contains(el))) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 150));
      }

      const workdayMultiId = el.getAttribute?.('data-uxi-multiselect-id');
      if (isWorkdayPage && workdayMultiId) {
        const selectedPills = Array.from(document.querySelectorAll(
          '[data-automation-id="selectedItem"][data-uxi-multiselect-id="' + workdayMultiId + '"]'
        ));
        const selectedTexts = selectedPills.map(p => (p.getAttribute('data-automation-label') || p.getAttribute('title') || p.textContent || '').trim());
        const hasDesired = selectedTexts.some(t => {
          const tn = normalizeText(t);
          return tn === normalizeText(requestedValue) ||
            (/country phone code/.test(labelNorm) && /united states.*\\(\\+1\\)/.test(tn)) ||
            (/how did you hear/.test(labelNorm) && tn === 'linkedin' && normalizeText(requestedValue) === 'linkedin');
        });
        if (selectedPills.length && !hasDesired) {
          for (const pill of selectedPills) {
            const deleteCharm = pill.querySelector('[data-automation-id="DELETE_charm"]') || pill;
            deleteCharm.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            deleteCharm.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            deleteCharm.click();
            await new Promise(r => setTimeout(r, 180));
          }
        } else if (hasDesired) {
          return { output: 'Workday field already has selected value "' + selectedTexts.join(', ') + '"' };
        }
      }

      if (isDropdownTrigger) {
        el.click();
        await new Promise(r => setTimeout(r, 500));
        const popup = document.querySelector('[role="listbox"]');
        const searchInput = popup
          ? popup.querySelector('input') || popup.parentElement?.querySelector('input')
          : document.querySelector('[role="combobox"]:not([aria-hidden="true"])') ||
            document.querySelector('input[aria-activedescendant]');
        if (searchInput && searchInput instanceof HTMLInputElement) {
          inp = searchInput;
          hasSearchInput = true;
        }
      } else {
        inp = el;
        if (comboboxAncestor) {
          inp = comboboxAncestor.querySelector('input') || comboboxAncestor;
        } else if (hasComboboxInput) {
          inp = hasComboboxInput;
        } else if (el.tagName !== 'INPUT') {
          inp = el.querySelector('input') || el;
        }
        hasSearchInput = inp instanceof HTMLInputElement;
        inp.focus();
        inp.click();
        await new Promise(r => setTimeout(r, 300));
      }

      if (hasSearchInput && inp) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(inp, '');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 100));
          nativeSetter.call(inp, typedQuery);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          inp.value = typedQuery;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      // Find options anywhere on the page — including inside open shadow roots and across
      // React portals that may render outside the combobox's aria-owns container. The previous
      // implementation only scanned the aria-owns subtree, which silently failed on
      // react-select (Greenhouse, Lever) and intl-tel-input where the popup is portaled.
      const collectOptions = () => {
        const found = new Set();
        const walk = (root) => {
          if (!root || !root.querySelectorAll) return;
          for (const opt of root.querySelectorAll('[role="option"]:not([aria-disabled="true"])')) {
            if (opt.offsetParent !== null || opt.offsetHeight > 0) found.add(opt);
          }
          const walker = root.createTreeWalker
            ? root.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
            : null;
          if (!walker) return;
          let node = walker.nextNode();
          while (node) {
            if (node.shadowRoot) walk(node.shadowRoot);
            node = walker.nextNode();
          }
        };
        walk(document);
        return Array.from(found);
      };

      let ddOptions = [];
      // Poll up to ~3s: short intervals up front catch synchronous renders, longer ones
      // catch slow react-select/Greenhouse fetches.
      const pollDelays = [120, 120, 160, 200, 250, 300, 400, 500, 500, 500];
      for (const delay of pollDelays) {
        await new Promise(r => setTimeout(r, delay));
        ddOptions = collectOptions();
        if (ddOptions.length > 0) break;
      }

      // Keyboard fallback: if no role="option" elements ever appeared, some widgets only
      // commit selections via ArrowDown + Enter (no DOM listbox is rendered at all). Try it
      // before giving up so the agent doesn't burn turns retrying the same typed value.
      if (ddOptions.length === 0 && hasSearchInput && inp) {
        if (isWorkdayPromptInput) {
          inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          await new Promise(r => setTimeout(r, 400));
          if ((inp.value || '').trim() === '') {
            return { output: 'Committed Workday prompt value "' + value + '" directly (no listbox rendered)' };
          }
        }
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
        await new Promise(r => setTimeout(r, 150));
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        // If typing committed something into the underlying field, declare success.
        const ownerInput = comboboxAncestor
          ? comboboxAncestor.querySelector('input[type="hidden"], select')
          : null;
        const committedVal = (ownerInput && ownerInput.value)
          || (inp.value && inp.value !== String(value) ? inp.value : '');
        if (committedVal) {
          return { output: 'Selected "' + committedVal + '" via keyboard (no listbox was rendered for "' + value + '")' };
        }
          return { error: 'No dropdown options appeared after typing "' + typedQuery + '" and keyboard fallback did not commit. Try clicking the container first, then use form_input on the input inside it.' };
      }

      const searchStr = normalizeText(requestedValue);
      const typedSearchStr = normalizeText(typedQuery);
      let matched = null;
      let fallbackMatched = false;
      const tokenizeForMatch = (s) => normalizeText(s)
        .replace(/[()]/g, ' ')
        .replace(/[^a-z0-9+]+/g, ' ')
        .split(/\\s+/)
        .filter(t => t && !['and','or','of','the','a','an','select','one','required','general'].includes(t))
        .map(t => t.endsWith('s') && t.length > 3 ? t.slice(0, -1) : t);
      const similarityScore = (query, option) => {
        const q = tokenizeForMatch(query);
        const o = tokenizeForMatch(option);
        if (!q.length || !o.length) return 0;
        let overlap = 0;
        for (const qt of q) {
          if (o.some(ot => ot === qt || ot.includes(qt) || qt.includes(ot))) overlap++;
        }
        const overlapScore = overlap / Math.max(q.length, 1);
        const optionPenalty = Math.min(o.length / Math.max(q.length, 1), 5);
        return overlapScore / Math.sqrt(optionPenalty);
      };
      const preferred = [];
      if (isWorkdayPage && /country phone code/.test(labelNorm) && /^(\\+?1|us|usa|united)$/.test(searchStr)) {
        preferred.push('united states of america (+1)', 'united states (+1)');
      }
      if (preferred.length) {
        for (const want of preferred) {
          for (const opt of ddOptions) {
            if (normalizeText(opt.textContent) === want) { matched = opt; break; }
          }
          if (matched) break;
        }
      }
      for (const opt of ddOptions) {
        if (normalizeText(opt.textContent) === searchStr) { matched = opt; break; }
      }
      if (!matched) {
        let bestLen = Infinity;
        for (const opt of ddOptions) {
          const text = normalizeText(opt.textContent);
          if ((text.includes(searchStr) || text.includes(typedSearchStr)) && text.length < bestLen) { matched = opt; bestLen = text.length; }
        }
      }
      if (!matched) {
        let bestLen2 = 0;
        for (const opt of ddOptions) {
          const text = normalizeText(opt.textContent);
          if (text.length >= 3 && (searchStr.includes(text) || typedSearchStr.includes(text)) && text.length > bestLen2) { matched = opt; bestLen2 = text.length; }
        }
      }
      if (!matched) {
        const words = searchStr.split(/[\\s,]+/).filter(Boolean);
        if (words.length > 1) {
          for (const opt of ddOptions) {
            const text = normalizeText(opt.textContent);
            if (words.every(w => text.includes(w))) { matched = opt; break; }
          }
        }
      }
      if (!matched && ddOptions.length === 1) matched = ddOptions[0];

      if (!matched) {
        let best = null;
        let bestScore = 0;
        for (const opt of ddOptions) {
          const text = (opt.textContent || '').trim();
          const score = Math.max(similarityScore(requestedValue, text), similarityScore(typedQuery, text));
          if (score > bestScore) {
            best = opt;
            bestScore = score;
          }
        }
        const minScore = isWorkdayPage ? 0.34 : 0.45;
        if (best && bestScore >= minScore) {
          matched = best;
          fallbackMatched = true;
        }
      }

      if (!matched) {
        const available = ddOptions.map(o => (o.textContent || '').trim()).filter(Boolean).slice(0, 15);
        return { error: 'No matching option for "' + value + '". Available: ' + available.join(', ') + '. Pick the closest available option rather than retrying the same unavailable value.' };
      }

      matched.scrollIntoView({ block: 'nearest' });
      // React-select v5 (Greenhouse, Lever) commits selections on mousedown — synthetic
      // .click() alone is a no-op because the lib calls preventDefault on click. Dispatch the
      // full sequence so both library paths work.
      const rect = matched.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const evtInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
      matched.dispatchEvent(new PointerEvent('pointerdown', { ...evtInit, pointerType: 'mouse' }));
      matched.dispatchEvent(new MouseEvent('mousedown', evtInit));
      matched.dispatchEvent(new PointerEvent('pointerup', { ...evtInit, pointerType: 'mouse' }));
      matched.dispatchEvent(new MouseEvent('mouseup', evtInit));
      matched.click();
      await new Promise(r => setTimeout(r, 500));
      const selectedText = (matched.textContent || '').trim();
      if (isWorkdayPage) {
        const scope = fieldScopeFor(el);
        const scopeText = normalizeText([
          scope?.textContent || '',
          comboboxAncestor?.textContent || '',
          el.getAttribute('aria-label') || '',
          el.value || '',
        ].join(' '));
        const selectedNorm = normalizeText(selectedText);
        const fieldHasSelection = selectedNorm && (
          scopeText.includes(selectedNorm) ||
          (/country phone code/.test(labelNorm) && /united states.*\\(\\+1\\)/.test(scopeText)) ||
          (/how did you hear/.test(labelNorm) && /linkedin|job boards|social media|career websites/.test(scopeText))
        );
        const stillOpen = Array.from(document.querySelectorAll('[data-automation-id="activeListContainer"], [role="listbox"]'))
          .some(list => (list.offsetParent !== null || list.getClientRects().length) && list.textContent && list.textContent.includes(selectedText));
        if (!fieldHasSelection && stillOpen) {
          return {
            error: 'Clicked "' + selectedText + '" but Workday did not commit it to the field "' + (fieldLabel || el.getAttribute('aria-label') || el.tagName) + '". The option list is still open; call read_page mode="full" and click the option ref from the OPEN DROPDOWN section.',
          };
        }
      }
      const fallbackNote = fallbackMatched ? ' closest available match for "' + requestedValue + '"' : 'searched: "' + requestedValue + '"';
      return { output: 'Selected "' + selectedText + '" from dropdown (' + fallbackNote + ')' };
    }

    // CHECKBOX
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      if (typeof value !== "boolean") return { error: "Checkbox requires a boolean value (true/false)" };
      const prev = el.checked;
      if (el.checked !== value) el.click();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { output: 'Checkbox ' + (el.checked ? 'checked' : 'unchecked') + ' (was: ' + prev + ')' };
    }

    // RADIO
    if (el instanceof HTMLInputElement && el.type === "radio") {
      el.click();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      if (!el.checked) {
        const label = el.id && window.CSS && CSS.escape ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
        const wrapper = el.closest('label, [role="radio"], [data-automation-id*="radio"], [data-automation-id*="Radio"]');
        (label || wrapper)?.click?.();
        await new Promise(r => setTimeout(r, 120));
      }
      if (!el.checked) {
        return { error: 'Radio button click did not check the control. Use read_page for fresh refs and click the visible radio option or its label/container.' };
      }
      const group = el.name ? ' in group "' + el.name + '"' : '';
      return { output: 'Radio button selected' + group };
    }

    // DATE/TIME
    if (el instanceof HTMLInputElement &&
        ["date", "time", "datetime-local", "month", "week"].includes(el.type)) {
      const prev = el.value;
      el.value = String(value);
      el.focus();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { output: 'Set ' + el.type + ' to "' + el.value + '" (was: "' + prev + '")' };
    }

    // RANGE
    if (el instanceof HTMLInputElement && el.type === "range") {
      const num = Number(value);
      if (isNaN(num)) return { error: "Range input requires numeric value" };
      const prev = el.value;
      el.value = String(num);
      el.focus();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { output: 'Set range to ' + el.value + ' (was: ' + prev + ', min: ' + el.min + ', max: ' + el.max + ')' };
    }

    // NUMBER
    if (el instanceof HTMLInputElement && el.type === "number") {
      const num = Number(value);
      if (isNaN(num) && value !== "") return { error: "Number input requires numeric value" };
      const prev = el.value;
      el.value = String(value);
      el.focus();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { output: 'Set number to ' + el.value + ' (was: "' + prev + '")' };
    }

    // TEXT INPUT and TEXTAREA
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const prev = el.value;
      // Phase 7.4 — Date format adaptation for text-based date fields.
      // Workday, Greenhouse, iCIMS, etc. render dates as plain text inputs with
      // a placeholder like "MM/DD/YYYY" instead of <input type=date>. The agent
      // routinely passes profile dates in ISO ("1990-05-15") and Workday silently
      // rejects them. Detect the field by signal (placeholder/aria/label) and
      // reformat the supplied value to match before typing.
      let typedValue = String(value);
      let dateAdapted = false;
      let dateFormatLabel = null;
      if (el instanceof HTMLInputElement && (el.type === 'text' || el.type === '' || el.type === 'search' || el.type === 'tel')) {
        const placeholder = (el.placeholder || '').trim();
        const ariaLabel = (el.getAttribute('aria-label') || '').trim();
        const labelText = (() => {
          if (el.id && window.CSS && CSS.escape) {
            const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (lab) return (lab.textContent || '').trim();
          }
          return '';
        })();
        const automationId = (el.getAttribute('data-automation-id') || '').toLowerCase();
        const looksLikeDateField = /\\b(mm[\\/\\-.]dd[\\/\\-.]yyyy|dd[\\/\\-.]mm[\\/\\-.]yyyy|yyyy[\\/\\-.]mm[\\/\\-.]dd|m\\/d\\/yyyy|d\\/m\\/yyyy)\\b/i.test(placeholder)
          || /\\bdate\\b/i.test(ariaLabel)
          || /\\bdate\\b/i.test(labelText)
          || /date(input)?$|dateofbirth|startdate|enddate/.test(automationId);

        if (looksLikeDateField) {
          // Parse the supplied value into a Date.
          const parseSupplied = (s) => {
            s = String(s).trim();
            if (!s) return null;
            // ISO: YYYY-MM-DD
            let m = s.match(/^(\\d{4})-(\\d{1,2})-(\\d{1,2})$/);
            if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
            // US: M/D/YYYY or MM/DD/YYYY
            m = s.match(/^(\\d{1,2})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{2,4})$/);
            if (m) {
              const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
              return { y, mo: +m[1], d: +m[2] };
            }
            // YYYY/MM/DD
            m = s.match(/^(\\d{4})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{1,2})$/);
            if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
            // Month DD YYYY
            const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
            m = s.match(/^([a-z]+)\\s+(\\d{1,2}),?\\s+(\\d{4})$/i);
            if (m) {
              const mo = monthNames.indexOf(m[1].toLowerCase()) + 1;
              if (mo > 0) return { y: +m[3], mo, d: +m[2] };
            }
            return null;
          };
          const dt = parseSupplied(value);
          if (dt) {
            const pad = (n) => String(n).padStart(2, '0');
            // Determine target format from placeholder, defaulting to MM/DD/YYYY.
            let format = 'MM/DD/YYYY';
            const ph = placeholder.toLowerCase();
            if (/dd[\\/\\-.]mm[\\/\\-.]yyyy/.test(ph)) format = 'DD/MM/YYYY';
            else if (/yyyy[\\/\\-.]mm[\\/\\-.]dd/.test(ph)) format = 'YYYY-MM-DD';
            else if (/mm[\\/\\-.]yyyy/.test(ph) && !/dd/.test(ph)) format = 'MM/YYYY';
            dateFormatLabel = format;
            if (format === 'MM/DD/YYYY') typedValue = pad(dt.mo) + '/' + pad(dt.d) + '/' + dt.y;
            else if (format === 'DD/MM/YYYY') typedValue = pad(dt.d) + '/' + pad(dt.mo) + '/' + dt.y;
            else if (format === 'YYYY-MM-DD') typedValue = dt.y + '-' + pad(dt.mo) + '-' + pad(dt.d);
            else if (format === 'MM/YYYY') typedValue = pad(dt.mo) + '/' + dt.y;
            dateAdapted = (typedValue !== String(value));
          }
        }
      }

      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) { nativeSetter.call(el, typedValue); } else { el.value = typedValue; }
      el.focus();
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      // Phase 7.4 — Tab commit. Many React date inputs only validate on blur+Tab.
      if (dateAdapted) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true }));
      }
      if ((el instanceof HTMLTextAreaElement ||
           (el instanceof HTMLInputElement &&
            ["text", "search", "url", "tel", "password", "email"].includes(el.type))) &&
          el.setSelectionRange) {
        try { el.setSelectionRange(el.value.length, el.value.length); } catch(e) {}
      }
      // Phase 7.4 — post-commit verification. Surface a structured failure when
      // the value reverted (controlled component rejected it, e.g. an unmatched
      // date format), so the agent gets actionable feedback instead of believing
      // the field is filled.
      const committed = el.value;
      if (String(typedValue).length > 0 && (!committed || committed.length === 0)) {
        return {
          error: 'Typed "' + typedValue + '" but the field is empty after blur. The control likely rejected the value (date/format mismatch, controlled component, or unsupported text). Inspect the placeholder and try a different format' + (dateFormatLabel ? ' (placeholder suggested ' + dateFormatLabel + ')' : '') + '.',
        };
      }
      const type = el instanceof HTMLTextAreaElement ? 'textarea' : (el.type || 'text');
      const note = dateAdapted ? ' [reformatted ' + JSON.stringify(value) + ' → "' + typedValue + '" to match ' + (dateFormatLabel || 'placeholder') + ']' : '';
      return { output: 'Set ' + type + ' to "' + committed + '" (was: "' + prev + '")' + note };
    }

    // CONTENTEDITABLE
    if (el.contentEditable === 'true' || el.isContentEditable) {
      const prev = el.textContent;
      el.textContent = String(value);
      el.focus();
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      return { output: 'Set contenteditable to "' + el.textContent + '" (was: "' + prev + '")' };
    }

    return { error: 'Element type "' + el.tagName + '" is not a supported form input' };
  } catch (err) {
    return { error: 'Error setting form value: ' + (err.message || 'Unknown error') };
  }
}`;

/**
 * Handle form_input tool - set form element values using ref
 *
 * @param {Object} input - Tool input
 * @param {string|number} input.ref - Element reference (numeric backendNodeId or "ref_N")
 * @param {string|boolean|number} input.value - Value to set
 * @param {number} input.tabId - Tab ID
 * @returns {Promise<{output?: string, error?: string}>}
 */
export async function handleFormInput(input) {
  try {
    if (!input?.ref) {
      throw new Error("ref parameter is required");
    }
    if (input.value === undefined || input.value === null) {
      throw new Error("Value parameter is required");
    }
    if (!input.tabId) {
      throw new Error("No active tab found");
    }

    const tabId = input.tabId;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.id) {
      throw new Error("Active tab has no ID");
    }

    // CDP path: numeric backendNodeId (from read_page)
    const backendNodeId = elementResolver.parseRef(input.ref);
    if (backendNodeId) {
      try {
        await ensureDebugger(tabId);
        const result = await elementResolver.callFunction(
          tabId,
          backendNodeId,
          FORM_MANIPULATION_FN,
          [{ value: input.value }],
        );
        return result || { error: 'No result from form manipulation' };
      } catch (err) {
        return { error: `Form input failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
      }
    }

    // Legacy path: ref_N format via content script WeakRef
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      // eslint-disable-next-line sonarjs/cognitive-complexity
      func: async (ref, value) => {
        try {
          let element = null;
          if (window.__elementRefMap && window.__elementRefMap[ref]) {
            element = window.__elementRefMap[ref].deref() || null;
            if (!element || !document.contains(element)) {
              delete window.__elementRefMap[ref];
              element = null;
            }
          }
          if (!element) {
            return { error: 'No element found with reference: "' + ref + '". The element may have been removed from the page.' };
          }
          element.scrollIntoView({ behavior: "smooth", block: "center" });

          // SELECT
          if (element instanceof HTMLSelectElement) {
            const prev = element.value;
            const options = Array.from(element.options);
            const valueStr = String(value);
            let found = false;
            for (let i = 0; i < options.length; i++) {
              if (options[i].value === valueStr || options[i].text === valueStr ||
                  options[i].text.toLowerCase() === valueStr.toLowerCase()) {
                element.selectedIndex = i; found = true; break;
              }
            }
            if (!found) return { error: 'Option "' + valueStr + '" not found. Available: ' + options.map(o => '"' + o.text + '" (value: "' + o.value + '")').join(', ') };
            element.focus();
            element.dispatchEvent(new Event("change", { bubbles: true }));
            element.dispatchEvent(new Event("input", { bubbles: true }));
            return { output: 'Selected "' + valueStr + '" (previous: "' + prev + '")' };
          }

          // CHECKBOX
          if (element instanceof HTMLInputElement && element.type === "checkbox") {
            if (typeof value !== "boolean") return { error: "Checkbox requires boolean" };
            const prev = element.checked;
            if (element.checked !== value) element.click();
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return { output: 'Checkbox ' + (element.checked ? 'checked' : 'unchecked') + ' (was: ' + prev + ')' };
          }

          // RADIO
          if (element instanceof HTMLInputElement && element.type === "radio") {
            element.click();
            element.dispatchEvent(new Event("change", { bubbles: true }));
            await new Promise(r => setTimeout(r, 120));
            if (!element.checked) {
              const label = element.id && window.CSS && CSS.escape ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]') : null;
              const wrapper = element.closest('label, [role="radio"], [data-automation-id*="radio"], [data-automation-id*="Radio"]');
              (label || wrapper)?.click?.();
              await new Promise(r => setTimeout(r, 120));
            }
            if (!element.checked) return { error: 'Radio button click did not check the control. Use read_page for fresh refs and click the visible radio option or its label/container.' };
            return { output: 'Radio button selected' + (element.name ? ' in group "' + element.name + '"' : '') };
          }

          // TEXT INPUT, TEXTAREA, NUMBER, DATE, RANGE, CONTENTEDITABLE
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            const prev = element.value;
            const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (nativeSetter) nativeSetter.call(element, String(value));
            else element.value = String(value);
            element.focus();
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
            const type = element instanceof HTMLTextAreaElement ? 'textarea' : (element.type || 'text');
            return { output: 'Set ' + type + ' to "' + element.value + '" (was: "' + prev + '")' };
          }

          if (element.contentEditable === 'true' || element.isContentEditable) {
            const prev = element.textContent;
            element.textContent = String(value);
            element.focus();
            element.dispatchEvent(new Event("input", { bubbles: true }));
            return { output: 'Set contenteditable to "' + element.textContent + '" (was: "' + prev + '")' };
          }

          return { error: 'Element type "' + element.tagName + '" is not a supported form input' };
        } catch (err) {
          return { error: 'Error setting form value: ' + (err instanceof Error ? err.message : 'Unknown error') };
        }
      },
      args: [input.ref, input.value],
    });

    if (!result || result.length === 0) {
      throw new Error("Failed to execute form input");
    }

    return result[0].result;
  } catch (err) {
    return {
      error: `Failed to execute form input: ${err instanceof Error ? err.message : "Unknown error"}`,
    };
  }
}
