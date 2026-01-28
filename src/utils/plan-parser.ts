/**
 * Utility for parsing natural language dashboard plans into structured widget configurations.
 * This is a pure JS/TS file that can be used on both client and server.
 * 
 * Enhanced with robust regex patterns that handle variations in AI output.
 */

export function extractDashboardTitle(planText: string): string | null {
    // Clean markdown first
    const cleaned = planText.replace(/\*\*|\*|__|#/g, '');

    // Try explicit patterns
    const titleMatch = cleaned.match(/(?:1\)|Dashboard Title|DASHBOARD TITLE)[:\s]+(.+?)(?:\n|$)/i);
    if (titleMatch) return titleMatch[1].trim();

    // Try "Title:" pattern
    const simpleTitleMatch = cleaned.match(/^Title[:\s]+(.+?)(?:\n|$)/im);
    if (simpleTitleMatch) return simpleTitleMatch[1].trim();

    // Fallback: Use first meaningful line
    const firstLine = cleaned.split('\n').find(l => l.trim().length > 5 && l.trim().length < 100);
    if (firstLine) return firstLine.trim();

    return null;
}

export function parseNaturalLanguagePlan(planText: string): any[] {
    const widgets: any[] = [];
    let widgetId = 1;

    // Clean markdown formatting that might confuse parsing
    const cleaned = planText.replace(/\*\*|\*|__|#/g, '');

    // ========== 0. Parse "Widget List" format ==========
    const widgetMatches = Array.from(cleaned.matchAll(/(?:^|\n)\s*WIDGET\s*\d+\s*(?:[:\-\.]|\))?/gi));
    if (widgetMatches.length > 0) {
        const blocks: string[] = [];
        widgetMatches.forEach((match, index) => {
            const start = match.index ? match.index + (match[0].startsWith('\n') ? 1 : 0) : 0;
            const end = index + 1 < widgetMatches.length ? (widgetMatches[index + 1].index || cleaned.length) : cleaned.length;
            blocks.push(cleaned.slice(start, end).trim());
        });

        blocks.forEach((block, index) => {
            const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length === 0) return;

            const header = lines[0];
            const headerMatch = header.match(/WIDGET\s*\d+\s*[:\-\.]?\s*(.+)$/i);
            const headerText = headerMatch && headerMatch[1].trim() ? headerMatch[1].trim() : header;

            const typeFromHeaderMatch = headerText.match(/^([A-Za-z\s]+)\s*-\s+/);
            const typeMatch = headerText.match(/\(([^)]+)\)/i)
                || (typeFromHeaderMatch ? [typeFromHeaderMatch[0], typeFromHeaderMatch[1]] : null)
                || block.match(/Type[:\s]*([^\n]+)/i);
            const rawType = typeMatch ? String(typeMatch[1]).trim().toLowerCase() : '';

            const title = headerText
                .replace(/\([^)]+\)/g, '')
                .replace(/^[A-Za-z\s]+-\s+/, '')
                .trim() || `Widget ${index + 1}`;

            const showsMatch = block.match(/Shows[:\s]*([^\n]+)/i) || block.match(/What data it shows[:\s]*([^\n]+)/i);
            const valueMatch = block.match(/Value[:\s]*([^\n]+)/i)
                || block.match(/Why[:\s]*([^\n]+)/i)
                || block.match(/Why it is valuable[:\s]*([^\n]+)/i);
            const usesMatch = block.match(/Uses[:\s]*([^\n]+)/i) || block.match(/Which tables\/columns it uses[:\s]*([^\n]+)/i);
            const notesMatch = block.match(/Notes[:\s]*([^\n]+)/i);

            const goal = (showsMatch?.[1] || valueMatch?.[1] || '').trim() || "Visualization";

            const typeText = rawType;
            let type = 'bar';
            if (/kpi|stat|metric/.test(typeText)) type = 'kpi';
            else if (/line|trend/.test(typeText)) type = 'line';
            else if (/area/.test(typeText)) type = 'line';
            else if (/bar|column|stacked/.test(typeText)) type = 'bar';
            else if (/pie|donut/.test(typeText)) type = 'donut';
            else if (/table/.test(typeText)) type = 'table';

            let primaryTable: string | undefined;
            if (usesMatch?.[1]) {
                const tableColMatch = usesMatch[1].match(/([a-zA-Z0-9_]+)\.[a-zA-Z0-9_]+/);
                if (tableColMatch) primaryTable = tableColMatch[1];
            }

            widgets.push({
                id: `w${widgetId++}`,
                type,
                title,
                goal,
                primaryTable,
                notes: notesMatch?.[1]?.trim(),
                layoutHint: type === 'kpi' ? 'row1' : (type === 'table' ? 'row4' : 'row2')
            });
        });

        // Promote the first chart to full width for layout hints
        const firstChart = widgets.find(w => w.type !== 'kpi' && w.type !== 'table');
        if (firstChart && firstChart.layoutHint === 'row2') {
            firstChart.layoutHint = 'row2-full';
        }

        if (widgets.length > 0) {
            console.log(`[PARSER] Extracted ${widgets.length} widgets from Widget List format.`);
            return widgets;
        }
    }

    // ========== 0.5 Parse numbered list format ==========
    const numberedMatches = Array.from(cleaned.matchAll(/(?:^|\n)\s*\d+\s*[).]\s+([^\n]+)/g));
    if (numberedMatches.length > 0) {
        const blocks: string[] = [];
        numberedMatches.forEach((match, index) => {
            const start = match.index ? match.index + (match[0].startsWith('\n') ? 1 : 0) : 0;
            const end = index + 1 < numberedMatches.length ? (numberedMatches[index + 1].index || cleaned.length) : cleaned.length;
            blocks.push(cleaned.slice(start, end).trim());
        });

        blocks.forEach((block, index) => {
            const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length === 0) return;

            const headerLine = lines[0].replace(/^\d+\s*[).]\s+/, '').trim();
            const typeFromHeaderMatch = headerLine.match(/^([A-Za-z\s]+)\s*-\s+/);
            const typeMatch = headerLine.match(/\(([^)]+)\)/i)
                || (typeFromHeaderMatch ? [typeFromHeaderMatch[0], typeFromHeaderMatch[1]] : null)
                || block.match(/Type[:\s]*([^\n]+)/i);
            const rawType = typeMatch ? String(typeMatch[1]).trim().toLowerCase() : '';

            const title = headerLine
                .replace(/\([^)]+\)/g, '')
                .replace(/^[A-Za-z\s]+-\s+/, '')
                .trim() || `Widget ${index + 1}`;

            const showsMatch = block.match(/Shows[:\s]*([^\n]+)/i);
            const valueMatch = block.match(/Value[:\s]*([^\n]+)/i) || block.match(/Why[:\s]*([^\n]+)/i);
            const usesMatch = block.match(/Uses[:\s]*([^\n]+)/i);
            const notesMatch = block.match(/Notes[:\s]*([^\n]+)/i);

            const goal = (showsMatch?.[1] || valueMatch?.[1] || '').trim() || "Visualization";

            let type = 'bar';
            if (/kpi|stat|metric/.test(rawType)) type = 'kpi';
            else if (/line|trend/.test(rawType)) type = 'line';
            else if (/area/.test(rawType)) type = 'line';
            else if (/bar|column|stacked/.test(rawType)) type = 'bar';
            else if (/pie|donut/.test(rawType)) type = 'donut';
            else if (/table/.test(rawType)) type = 'table';

            let primaryTable: string | undefined;
            if (usesMatch?.[1]) {
                const tableColMatch = usesMatch[1].match(/([a-zA-Z0-9_]+)\.[a-zA-Z0-9_]+/);
                if (tableColMatch) primaryTable = tableColMatch[1];
            }

            widgets.push({
                id: `w${widgetId++}`,
                type,
                title,
                goal,
                primaryTable,
                notes: notesMatch?.[1]?.trim(),
                layoutHint: type === 'kpi' ? 'row1' : (type === 'table' ? 'row4' : 'row2')
            });
        });

        const firstChart = widgets.find(w => w.type !== 'kpi' && w.type !== 'table');
        if (firstChart && firstChart.layoutHint === 'row2') {
            firstChart.layoutHint = 'row2-full';
        }

        if (widgets.length > 0) {
            console.log(`[PARSER] Extracted ${widgets.length} widgets from numbered list format.`);
            return widgets;
        }
    }

    // ========== 1. Parse KPI Cards ==========
    // Match section that starts with "KPI Cards" or "3)" and ends before Charts or Detail Tables
    const kpiSectionMatch = cleaned.match(/(?:3\)|KPI Cards?)[^\n]*[\s\S]*?(?=(?:4\)|Charts?)|(?:5\)|Detail)|(?:6\)|Assumptions)|$)/i);
    if (kpiSectionMatch) {
        const kpiSection = kpiSectionMatch[0];

        // Split by "Card title:" to get individual cards
        const cardBlocks = kpiSection.split(/Card title[:\s]*/i);
        cardBlocks.shift(); // Remove header

        cardBlocks.forEach(block => {
            const lines = block.split('\n').filter(l => l.trim());
            if (lines.length === 0) return;

            const title = lines[0]?.trim() || "KPI Card";
            const metricMatch = block.match(/Metric definition[:\s]*([^\n]+)/i);
            const tableMatch = block.match(/Primary table[:\s]*([^\n]+)/i);

            widgets.push({
                id: `w${widgetId++}`,
                type: 'kpi',
                title: title.replace(/card$/i, '').trim(),
                goal: metricMatch?.[1]?.trim() || "Key performance indicator",
                primaryTable: tableMatch?.[1]?.trim(),
                layoutHint: 'row1'
            });
        });
    }

    // ========== 2. Parse Charts ==========
    const chartSectionMatch = cleaned.match(/(?:4\)|Charts?)[^\n]*[\s\S]*?(?=(?:5\)|Detail)|(?:6\)|Assumptions)|(?:7\)|Layout)|$)/i);
    if (chartSectionMatch) {
        const chartSection = chartSectionMatch[0];

        // Split by "Chart title:" to get individual charts
        const chartBlocks = chartSection.split(/Chart title[:\s]*/i);
        chartBlocks.shift(); // Remove header

        chartBlocks.forEach((block, index) => {
            const lines = block.split('\n').filter(l => l.trim());
            if (lines.length === 0) return;

            const title = lines[0]?.trim() || "Chart";
            const typeMatch = block.match(/Chart type[:\s]*(line|area|bar|stacked bar|donut|pie)/i);
            const metricMatch = block.match(/Metric[:\s]*([^\n]+)/i);
            const dimMatch = block.match(/Dimension[:\s]*([^\n]+)/i);
            const tableMatch = block.match(/Primary table[:\s]*([^\n]+)/i);

            let chartType = typeMatch?.[1]?.toLowerCase() || 'bar';
            if (chartType === 'stacked bar') chartType = 'bar';
            if (chartType === 'area') chartType = 'line';

            widgets.push({
                id: `w${widgetId++}`,
                type: chartType,
                title: title.replace(/chart$/i, '').trim(),
                goal: `${metricMatch?.[1]?.trim() || ''} by ${dimMatch?.[1]?.trim() || ''}`.trim() || "Visualization",
                dimension: dimMatch?.[1]?.trim(),
                primaryTable: tableMatch?.[1]?.trim(),
                layoutHint: index === 0 ? 'row2-full' : 'row3'
            });
        });
    }

    // ========== 3. Parse Detail Tables ==========
    const tableSectionMatch = cleaned.match(/(?:5\)|Detail Tables?)[^\n]*[\s\S]*?(?=(?:6\)|Assumptions)|(?:7\)|Layout)|$)/i);
    if (tableSectionMatch) {
        const tableSection = tableSectionMatch[0];

        // Split by "Table title:" to get individual tables
        const tableBlocks = tableSection.split(/Table title[:\s]*/i);
        tableBlocks.shift(); // Remove header

        tableBlocks.forEach(block => {
            const lines = block.split('\n').filter(l => l.trim());
            if (lines.length === 0) return;

            const title = lines[0]?.trim() || "Detail Table";
            const tableMatch = block.match(/Primary table[:\s]*([^\n]+)/i);
            const columnsMatch = block.match(/Columns shown[:\s]*([^\n]+)/i);
            const sortMatch = block.match(/Default sort[:\s]*([^\n]+)/i);

            widgets.push({
                id: `w${widgetId++}`,
                type: 'table',
                title: title.replace(/table$/i, '').trim(),
                goal: `Operational records from ${tableMatch?.[1]?.trim() || 'database'}`,
                primaryTable: tableMatch?.[1]?.trim(),
                columns: columnsMatch?.[1]?.trim(),
                defaultSort: sortMatch?.[1]?.trim(),
                layoutHint: 'row4'
            });
        });
    }

    // ========== Fallback: Generic bullet-point parsing ==========
    if (widgets.length === 0) {
        console.log("[PARSER] No structured widgets found, using fallback parsing...");

        // Try generic bullet/numbered list items
        const fallbackRegex = /[-*•]\s*([^:\n]+)[:\s]+([^\n]+)/g;
        let match;
        while ((match = fallbackRegex.exec(cleaned)) !== null) {
            const title = match[1].trim();
            const desc = match[2].trim();
            if (title.length < 60 && title.length > 2) {
                let type: string = 'kpi';
                const titleLower = title.toLowerCase();
                const descLower = desc.toLowerCase();

                if (/chart|trend|breakdown|over time|distribution/i.test(titleLower)) {
                    type = 'bar';
                    if (/trend|line|time/i.test(titleLower + descLower)) type = 'line';
                    else if (/pie|donut|breakdown/i.test(titleLower + descLower)) type = 'donut';
                } else if (/table|list|detail|record/i.test(titleLower)) {
                    type = 'table';
                }

                widgets.push({
                    id: `w${widgetId++}`,
                    type,
                    title,
                    goal: desc,
                    layoutHint: type === 'kpi' ? 'row1' : (type === 'table' ? 'row4' : 'row2')
                });
            }
        }
    }

    // ========== Minimum widgets guarantee ==========
    if (widgets.length === 0) {
        console.warn("[PARSER] No widgets extracted. Creating default widgets.");
        widgets.push({ id: 'w1', type: 'kpi', title: 'Summary Overview', goal: 'High level business summary', layoutHint: 'row1' });
        widgets.push({ id: 'w2', type: 'bar', title: 'Key Metrics', goal: 'Primary business metrics visualization', layoutHint: 'row2-full' });
        widgets.push({ id: 'w3', type: 'table', title: 'Recent Activity', goal: 'Latest operational records', layoutHint: 'row4' });
    }

    console.log(`[PARSER] Extracted ${widgets.length} widgets from plan.`);
    return widgets;
}
