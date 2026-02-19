import { buildTablePaginationMap, toRecordFromFilterMap } from "@/lib/pagination";

export const buildRuntimeParams = (
    planFilters: any[] = [],
    activeFilters: Map<string, any> | Record<string, any> | undefined
) => {
    const defaults = (planFilters || []).reduce((acc: Record<string, any>, filter: any) => {
        if (!filter?.dimension) return acc;
        acc[filter.dimension] = filter.value;
        return acc;
    }, {});

    return {
        ...defaults,
        ...toRecordFromFilterMap(activeFilters)
    };
};

export const buildExecutionContext = (input: {
    planFilters?: any[];
    activeFilters?: Map<string, any> | Record<string, any>;
    candidateWidgets?: any[];
    includeTotal?: boolean;
    allowGlobalFallback?: boolean;
}) => {
    const filterRecord = toRecordFromFilterMap(input.activeFilters);
    return {
        runtimeParams: buildRuntimeParams(input.planFilters || [], filterRecord),
        tablePagination: buildTablePaginationMap(filterRecord, input.candidateWidgets || [], {
            includeTotal: input.includeTotal !== false,
            allowGlobalFallback: input.allowGlobalFallback !== false
        })
    };
};
