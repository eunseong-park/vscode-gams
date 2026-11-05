* batinclude: %1 = set, %2 = label for report
Parameter rep_%2(%1) 'shipped totals per %1';
rep_%2(%1) = sum(%3, flow.l(%1,%3));
Display rep_%2;
