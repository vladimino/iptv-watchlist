# AIR-683: read-only diagnosis of the Film localization reconciliation cohort

Date: **26 November 2026** (UTC). Card: [AIR-683](https://trello.com/c/VJYgJuOW); upstream [AIR-663](https://trello.com/c/UP10l6Js), consumer [AIR-664](https://trello.com/c/Og9XxXfy); [ADR 0218](../../adr/0218-film-lifecycle-dimensions-revision.md) decision 3 stage 4 (unchanged). Runbook: [Read-only cohort diagnosis](../../runbooks/film-localization-reconciliation.md#read-only-cohort-diagnosis-air-683).

**Status: live diagnosis complete on 27 November 2026 (UTC).** The capability delivered on 26 November was exercised through the owner-only IPTV MCP identity on 27 November. No production repair was authorized or performed.

## 1. Existing means checked first

| Means | Result |
| --- | --- |
| Authorized read-only D1 SELECT (Cloudflare connector, IPTV MCP read tools) | Reads rows, cannot run `resolveLocalization` (owner precedence, redirect ancestors); an SQL filter would replace the effective-value check the card forbids. Not sufficient. |
| Offline private copy with proven freshness | None available. |
| Entry to the AIR-663 dry run | **None** (module was dormant): the one proven gap. |

## 2. Capability (offline, synthetic SQLite fixtures built from every migration)

- `diagnoseLocalizationCohort` (in `src/film-localization-reconciler.js`) over the same `classifyFilm` the dry run uses; the only Worker entry is the owner-only MCP tool `film_localization_diagnose`. No new service, Workflow, queue, storage, table or migration.
- Equality with the oracle: on a 121-Film fixture (5 stale, 1 reviewed-row hold, 1 redirect, the rest current) the contiguous ranges of the walk sum to the summed dry-run pages (stale ids, held reasons, noop, absent, unavailable).
- **Real limit** (review of the first revision corrected it): [D1 allows 1,000 queries per Worker invocation on Paid, a batch counting as one](https://developers.cloudflare.com/d1/platform/limits/) (page updated 20 Nov 2026); the earlier 10,000-subrequest and 500-Film rationale was wrong and is removed. The call counts its own D1 executions and stops before the next Film (`d1_query_budget`). Measured on the fixture: **2 invocations for 121 Films (983 + 486 D1 queries, none above 1,000 including the closing pin reads), at most 13 queries per Film.** A Film with many owner entries or ancestors costs more, which is why the stop uses the largest cost seen.
- Range semantics: a resumed call, a clean suffix after the last stale Film and a cursor beyond the last Film are never `complete` or `zeroEligible` (fixtures); an empty table with a non-D1 owner-review domain or a held marker is refused; a moved owner-review generation during the walk gives `pinsStable: false` and blocks zero; an unavailable Film is never zero.
- No effect: the fixture snapshot of `film_dimension`, `film_localization_source` and receipts is unchanged; `tests/get-write-audit.mjs` (8 scenarios, instrumented R2 and D1) shows no R2 or D1 write, receipt, workflow, dispatch, background or outbound effect; the tool is anonymous-refused (403) and never reads R2.

## 3. Live cohort (27 November 2026, scoped L0 read)

The Delivery Controller walked the canonical D1 Film table through the already delivered `film_localization_diagnose` entry, from the first Film to the last cursor. The implementation and its independent review were delivered in [PR #1027](https://github.com/vladimino/iptv-watchlist/pull/1027), main `b6fdb822ac441076a909becd1910ac4926fd6ace`; [post-merge CI/deploy](https://github.com/vladimino/iptv-watchlist/actions/runs/45785582713) passed. No alternate resolver or approximate SQL eligibility filter was used.

| Item | Live result |
| --- | --- |
| Examined | 13,867 |
| Current (noop) | 13,851 |
| Stale (eligible at the time observed) | 16 (0.1154% of examined Films) |
| Held / reasons | 0 / none |
| Absent (redirect or missing) | 0 |
| Unavailable / codes | 0 / none |
| Accepted invocations | 185 (184 normal `d1_query_budget` continuations; last `reachedEnd: true`) |
| D1 queries reported by accepted invocations | 182,136; largest call 989 of 1,000; largest reported per-Film query cost 14 |
| Sum of accepted invocation `elapsedMs` | 2,921,571 ms (48 min 41.571 s); not overall wall-clock time |
| Coverage | First call `startedAfter: ""`, last cursor `film:zu4c`, `reachedEnd: true`; independent read-only D1 count before and after: 13,867 Films; zero Films after the final cursor |
| Time boundary | 27 Nov 2026 UTC; first range recorded by 20:46:49 UTC in [Trello](https://trello.com/c/VJYgJuOW), final count and read-only probe by 21:49:41 UTC. These are evidence-record bounds, not exact start/end timestamps. |

The Controller's in-session validators checked every accepted response for HTTP 200, matching preceding cursor, strict advancement for nonterminal ranges, matching classification totals, normal continuation or terminal end, no failure, query budget, and identical stable start/end authority pins across the walk. The [sanitized invocation manifest](#4-sanitized-invocation-manifest) preserves the returned range observations and validation results for independent arithmetic and continuity checks. The pins were Film/Person `open`, generation 2, schema 38, baseline `verified`; owner-review `d1`, writes `open`, generation 1. The final read-only SQL verification returned schema 38 and `rows_written: 0`.

| Contiguous range groups | Start after | End cursor | Examined | Noop | Stale | D1 queries | Sum elapsed ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1-131 | empty | `film:tmdb:56648` | 9,825 | 9,812 | 13 | 129,050 | 2,083,410 |
| 132-185 | `film:tmdb:56648` | `film:zu4c` | 4,042 | 4,039 | 3 | 53,086 | 838,161 |
| Total | | | 13,867 | 13,851 | 16 | 182,136 | 2,921,571 |

One orchestration batch timed out without returned range evidence; its unconfirmed results were excluded, and the walk resumed from the last accepted cursor. There were no gaps in accepted ranges. The resource totals cover only the 185 returned, validated invocations, not the abandoned attempts, independent SQL count checks, probe, pauses or tool overhead. The first 75 Films were observed before the continuation request; the walk was not restarted for a clean result.

**Observed stale Film ids (16, sanitized; no localization values or intent bodies):**

`film:1XYA`, `film:27iE`, `film:28R6`, `film:DCVQ`, `film:MYia`, `film:QGFo`, `film:R9dS`, `film:RTwc`, `film:RfZI`, `film:iXBq`, `film:jGuE`, `film:tmdb:101669`, `film:tmdb:516486`, `film:tmdb:649409`, `film:vCu0`, `film:xG0M`.

**Verdict.** The walk is complete for the observed keyset ranges; it is not a globally consistent snapshot. Stable authority pins and equal start/end counts do not rule out concurrent Film edits or insertion behind a cursor. Positive stale counts correctly make affected ranges not clean; the all-`rangeClean` condition is required for a zero-eligible verdict, not for accepting a positive census. AIR-664 cannot be closed as a no-op. The owner approved the narrow, one-off operation for these 16 candidates on 27 November 2026 ([AIR-664 decision comment](https://trello.com/c/Og9XxXfy#comment-6b09fbd877f4915fc2dc5990)). Revalidate these candidates immediately before repair and reuse the existing resolver, per-Film fenced writer, receipt, pre-image and exact-revision restore contracts. Determine the minimal durable intent-recording mechanism against that real scope before selecting a storage or operator design. Do not assume the historical wave architecture is necessary, create a new service or implement writes from this evidence. Separate implementation authorization and owner-approved operation contract/GO are required.

The diagnosis invoked no production writer, external producer, sync, flag, migration, Task, Access change or R2/D1 mutation. The [read-side effect audit](../../reference/api/read-side-effects.md) and offline fixtures remain the evidence for the diagnostic entry's no-write behavior. Independent count verification and the read-only MCP probe also completed successfully. The diagnostic result, not the later repair, is the AIR-683 acceptance boundary.

## 4. Sanitized invocation manifest

Source: the actual returned tool results and compact in-session validation outputs retained in the Controller's 27 November conversation, transcribed after review without any new production call. This is a derived manifest, not an independently captured raw response archive. Each line preserves the returned end cursor, observed classifications, reported query count, elapsed time, maximum per-Film cost and terminal status. The preceding cursor is the accepted input; where the compact output omitted it, the validator required the returned `startedAfter` to equal that input before accepting the row. Rows 32-131 were printed as compact arrays with an aggregate `issue: null` and separate nonzero/truncation details; rows 132-185 included both cursors and classification details. The first and final full/compact results and each validated batch are retained in the conversation, but no externally accessible raw tool-response link is available. The independent reviewer can verify the cursor sequence, counts, IDs and resource sums from this manifest, not independently authenticate the original server responses or replay the live observations.

Common validation outcome for all 185 accepted rows: HTTP 200, matching input cursor, `pinsStable: true`, identical start and end pins (Film/Person open generation 2, version 38, verified baseline; owner-review d1/open generation 1), no failure, held/absent/unavailable all zero, empty reason/code maps, no stale or unavailable ID truncation. Nonterminal rows stopped at `d1_query_budget`; the terminal row reports `reachedEnd: true` (the compact terminal output did not preserve its `stopped` field). The common status is the Controller's reported validator result, not newly reconstructed raw pin objects. The timed-out batch has no accepted rows and is excluded.

Tab-separated fields: invocation, requested after, returned cursor, examined, noop, stale, stale IDs (semicolon-separated), D1 queries, elapsedMs, maxQueriesPerFilm, continuation/terminal. A dash means empty. The source outputs had all 75 examined per nonterminal call and 67 in the terminal call. Totals were mechanically recomputed from the transcribed rows: 185 rows, 13,867 examined, 13,851 noop, 16 distinct stale IDs, 182,136 reported queries, 2,921,571 ms. All cursors strictly advance.

```text
1	-	film:1XoW	75	74	1	film:1XYA	988	16964	14	budget
2	film:1XoW	film:28Bi	75	74	1	film:27iE	988	15702	14	budget
3	film:28Bi	film:5n0s	75	74	1	film:28R6	988	17927	14	budget
4	film:5n0s	film:aSVk	75	69	6	film:DCVQ;film:MYia;film:QGFo;film:R9dS;film:RTwc;film:RfZI	989	17952	14	budget
5	film:aSVk	film:mcHk	75	73	2	film:iXBq;film:jGuE	986	15484	14	budget
6	film:mcHk	film:tmdb:10045	75	75	0	-	986	15646	14	budget
7	film:tmdb:10045	film:tmdb:101267	75	75	0	-	985	15713	13	budget
8	film:tmdb:101267	film:tmdb:10199	75	74	1	film:tmdb:101669	985	15147	13	budget
9	film:tmdb:10199	film:tmdb:10295	75	75	0	-	985	14999	13	budget
10	film:tmdb:10295	film:tmdb:103747	75	75	0	-	985	15555	13	budget
11	film:tmdb:103747	film:tmdb:10479	75	75	0	-	985	15146	13	budget
12	film:tmdb:10479	film:tmdb:105864	75	75	0	-	985	15177	13	budget
13	film:tmdb:105864	film:tmdb:106747	75	75	0	-	985	17751	13	budget
14	film:tmdb:106747	film:tmdb:1076555	75	75	0	-	985	17380	13	budget
15	film:tmdb:1076555	film:tmdb:1085046	75	75	0	-	985	15374	13	budget
16	film:tmdb:1085046	film:tmdb:109424	75	75	0	-	985	17140	13	budget
17	film:tmdb:109424	film:tmdb:11026	75	75	0	-	985	17489	13	budget
18	film:tmdb:11026	film:tmdb:11096	75	75	0	-	985	17028	13	budget
19	film:tmdb:11096	film:tmdb:1119585	75	75	0	-	985	15200	13	budget
20	film:tmdb:1119585	film:tmdb:1128377	75	75	0	-	985	15434	13	budget
21	film:tmdb:1128377	film:tmdb:11397	75	75	0	-	985	15305	13	budget
22	film:tmdb:11397	film:tmdb:11498	75	75	0	-	985	18065	13	budget
23	film:tmdb:11498	film:tmdb:1159520	75	75	0	-	985	18793	13	budget
24	film:tmdb:1159520	film:tmdb:11675	75	75	0	-	985	17171	13	budget
25	film:tmdb:11675	film:tmdb:1181540	75	75	0	-	985	15766	13	budget
26	film:tmdb:1181540	film:tmdb:1190449	75	75	0	-	985	16282	13	budget
27	film:tmdb:1190449	film:tmdb:1202592	75	75	0	-	985	18894	13	budget
28	film:tmdb:1202592	film:tmdb:1215532	75	75	0	-	985	16149	13	budget
29	film:tmdb:1215532	film:tmdb:1224993	75	75	0	-	985	15603	13	budget
30	film:tmdb:1224993	film:tmdb:12400	75	75	0	-	985	15537	13	budget
31	film:tmdb:12400	film:tmdb:1250	75	75	0	-	985	17243	13	budget
32	film:tmdb:1250	film:tmdb:12610	75	75	0	-	985	17489	13	budget
33	film:tmdb:12610	film:tmdb:1267656	75	75	0	-	985	17625	13	budget
34	film:tmdb:1267656	film:tmdb:12770	75	75	0	-	985	15654	13	budget
35	film:tmdb:12770	film:tmdb:1289893	75	75	0	-	985	15001	13	budget
36	film:tmdb:1289893	film:tmdb:1304625	75	75	0	-	985	15077	13	budget
37	film:tmdb:1304625	film:tmdb:1320083	75	75	0	-	985	15671	13	budget
38	film:tmdb:1320083	film:tmdb:1339666	75	75	0	-	985	17175	13	budget
39	film:tmdb:1339666	film:tmdb:136080	75	75	0	-	985	15745	13	budget
40	film:tmdb:136080	film:tmdb:137182	75	75	0	-	985	17346	13	budget
41	film:tmdb:137182	film:tmdb:1386315	75	75	0	-	985	15052	13	budget
42	film:tmdb:1386315	film:tmdb:14040	75	75	0	-	985	16190	13	budget
43	film:tmdb:14040	film:tmdb:14194	75	75	0	-	985	15492	13	budget
44	film:tmdb:14194	film:tmdb:143112	75	75	0	-	985	15666	13	budget
45	film:tmdb:143112	film:tmdb:1448540	75	75	0	-	985	15953	13	budget
46	film:tmdb:1448540	film:tmdb:1462893	75	75	0	-	985	15782	13	budget
47	film:tmdb:1462893	film:tmdb:14805	75	75	0	-	985	15329	13	budget
48	film:tmdb:14805	film:tmdb:14979	75	75	0	-	985	15539	13	budget
49	film:tmdb:14979	film:tmdb:151535	75	75	0	-	985	17963	13	budget
50	film:tmdb:151535	film:tmdb:1535	75	75	0	-	985	15481	13	budget
51	film:tmdb:1535	film:tmdb:15676	75	75	0	-	985	15500	13	budget
52	film:tmdb:15676	film:tmdb:1589590	75	75	0	-	985	15132	13	budget
53	film:tmdb:1589590	film:tmdb:161509	75	75	0	-	985	15055	13	budget
54	film:tmdb:161509	film:tmdb:1638782	75	75	0	-	985	15390	13	budget
55	film:tmdb:1638782	film:tmdb:167073	75	75	0	-	985	14828	13	budget
56	film:tmdb:167073	film:tmdb:1711	75	75	0	-	985	17724	13	budget
57	film:tmdb:1711	film:tmdb:17599	75	75	0	-	985	17616	13	budget
58	film:tmdb:17599	film:tmdb:181564	75	75	0	-	985	15333	13	budget
59	film:tmdb:181564	film:tmdb:18639	75	75	0	-	985	14912	13	budget
60	film:tmdb:18639	film:tmdb:1903	75	75	0	-	985	17049	13	budget
61	film:tmdb:1903	film:tmdb:19458	75	75	0	-	985	16647	13	budget
62	film:tmdb:19458	film:tmdb:199327	75	75	0	-	985	14877	13	budget
63	film:tmdb:199327	film:tmdb:204082	75	75	0	-	985	15613	13	budget
64	film:tmdb:204082	film:tmdb:20759	75	75	0	-	985	14862	13	budget
65	film:tmdb:20759	film:tmdb:2098	75	75	0	-	985	15120	13	budget
66	film:tmdb:2098	film:tmdb:2148	75	75	0	-	985	15321	13	budget
67	film:tmdb:2148	film:tmdb:22029	75	75	0	-	985	16715	13	budget
68	film:tmdb:22029	film:tmdb:226	75	75	0	-	985	15097	13	budget
69	film:tmdb:226	film:tmdb:230181	75	75	0	-	985	15134	13	budget
70	film:tmdb:230181	film:tmdb:23816	75	75	0	-	985	17605	13	budget
71	film:tmdb:23816	film:tmdb:2433	75	75	0	-	985	16707	13	budget
72	film:tmdb:2433	film:tmdb:24793	75	75	0	-	985	16530	13	budget
73	film:tmdb:24793	film:tmdb:25237	75	75	0	-	985	15401	13	budget
74	film:tmdb:25237	film:tmdb:25682	75	75	0	-	985	15461	13	budget
75	film:tmdb:25682	film:tmdb:260969	75	75	0	-	985	14961	13	budget
76	film:tmdb:260969	film:tmdb:264999	75	75	0	-	985	14769	13	budget
77	film:tmdb:264999	film:tmdb:269405	75	75	0	-	985	16832	13	budget
78	film:tmdb:269405	film:tmdb:27418	75	75	0	-	985	15407	13	budget
79	film:tmdb:27418	film:tmdb:27905	75	75	0	-	985	15359	13	budget
80	film:tmdb:27905	film:tmdb:283552	75	75	0	-	985	14992	13	budget
81	film:tmdb:283552	film:tmdb:287947	75	75	0	-	985	14581	13	budget
82	film:tmdb:287947	film:tmdb:293863	75	75	0	-	985	15093	13	budget
83	film:tmdb:293863	film:tmdb:299537	75	75	0	-	985	14987	13	budget
84	film:tmdb:299537	film:tmdb:30577	75	75	0	-	985	15001	13	budget
85	film:tmdb:30577	film:tmdb:31013	75	75	0	-	985	18472	13	budget
86	film:tmdb:31013	film:tmdb:31605	75	75	0	-	985	16750	13	budget
87	film:tmdb:31605	film:tmdb:32084	75	75	0	-	985	14774	13	budget
88	film:tmdb:32084	film:tmdb:329805	75	75	0	-	985	14802	13	budget
89	film:tmdb:329805	film:tmdb:334354	75	75	0	-	985	15746	13	budget
90	film:tmdb:334354	film:tmdb:339103	75	75	0	-	985	17608	13	budget
91	film:tmdb:339103	film:tmdb:345009	75	75	0	-	985	17504	13	budget
92	film:tmdb:345009	film:tmdb:350	75	75	0	-	985	17358	13	budget
93	film:tmdb:350	film:tmdb:358926	75	75	0	-	985	18149	13	budget
94	film:tmdb:358926	film:tmdb:36586	75	75	0	-	985	15436	13	budget
95	film:tmdb:36586	film:tmdb:371645	75	75	0	-	985	14700	13	budget
96	film:tmdb:371645	film:tmdb:376812	75	75	0	-	985	15311	13	budget
97	film:tmdb:376812	film:tmdb:381237	75	75	0	-	985	14964	13	budget
98	film:tmdb:381237	film:tmdb:384737	75	75	0	-	985	15702	13	budget
99	film:tmdb:384737	film:tmdb:390883	75	75	0	-	985	14870	13	budget
100	film:tmdb:390883	film:tmdb:396373	75	75	0	-	985	14842	13	budget
101	film:tmdb:396373	film:tmdb:400452	75	75	0	-	985	17358	13	budget
102	film:tmdb:400452	film:tmdb:40448	75	75	0	-	985	15209	13	budget
103	film:tmdb:40448	film:tmdb:4104	75	75	0	-	985	15253	13	budget
104	film:tmdb:4104	film:tmdb:41579	75	75	0	-	985	15177	13	budget
105	film:tmdb:41579	film:tmdb:420809	75	75	0	-	985	15342	13	budget
106	film:tmdb:420809	film:tmdb:4254	75	75	0	-	985	15043	13	budget
107	film:tmdb:4254	film:tmdb:429199	75	75	0	-	985	14546	13	budget
108	film:tmdb:429199	film:tmdb:433501	75	75	0	-	985	15355	13	budget
109	film:tmdb:433501	film:tmdb:438590	75	75	0	-	985	15732	13	budget
110	film:tmdb:438590	film:tmdb:44453	75	75	0	-	985	14770	13	budget
111	film:tmdb:44453	film:tmdb:45019	75	75	0	-	985	15166	13	budget
112	film:tmdb:45019	film:tmdb:45460	75	75	0	-	985	15197	13	budget
113	film:tmdb:45460	film:tmdb:458305	75	75	0	-	985	14448	13	budget
114	film:tmdb:458305	film:tmdb:463698	75	75	0	-	985	14932	13	budget
115	film:tmdb:463698	film:tmdb:469185	75	75	0	-	985	14767	13	budget
116	film:tmdb:469185	film:tmdb:476292	75	75	0	-	985	17496	13	budget
117	film:tmdb:476292	film:tmdb:48297	75	75	0	-	985	15270	13	budget
118	film:tmdb:48297	film:tmdb:48987	75	75	0	-	985	16779	13	budget
119	film:tmdb:48987	film:tmdb:49426	75	75	0	-	985	14493	13	budget
120	film:tmdb:49426	film:tmdb:498248	75	75	0	-	985	16848	13	budget
121	film:tmdb:498248	film:tmdb:504172	75	75	0	-	985	15237	13	budget
122	film:tmdb:504172	film:tmdb:509	75	75	0	-	985	14752	13	budget
123	film:tmdb:509	film:tmdb:514921	75	75	0	-	985	16815	13	budget
124	film:tmdb:514921	film:tmdb:519010	75	74	1	film:tmdb:516486	985	14604	13	budget
125	film:tmdb:519010	film:tmdb:524047	75	75	0	-	985	16748	13	budget
126	film:tmdb:524047	film:tmdb:530385	75	75	0	-	985	14694	13	budget
127	film:tmdb:530385	film:tmdb:53505	75	75	0	-	985	15352	13	budget
128	film:tmdb:53505	film:tmdb:541	75	75	0	-	985	15019	13	budget
129	film:tmdb:541	film:tmdb:54970	75	75	0	-	985	17253	13	budget
130	film:tmdb:54970	film:tmdb:558041	75	75	0	-	985	15730	13	budget
131	film:tmdb:558041	film:tmdb:56648	75	75	0	-	985	15180	13	budget
132	film:tmdb:56648	film:tmdb:572802	75	75	0	-	985	15574	13	budget
133	film:tmdb:572802	film:tmdb:57776	75	75	0	-	985	15561	13	budget
134	film:tmdb:57776	film:tmdb:582429	75	75	0	-	985	15784	13	budget
135	film:tmdb:582429	film:tmdb:588	75	75	0	-	985	15369	13	budget
136	film:tmdb:588	film:tmdb:594328	75	75	0	-	985	14973	13	budget
137	film:tmdb:594328	film:tmdb:59860	75	75	0	-	985	15054	13	budget
138	film:tmdb:59860	film:tmdb:60547	75	75	0	-	985	15392	13	budget
139	film:tmdb:60547	film:tmdb:6107	75	75	0	-	985	15664	13	budget
140	film:tmdb:6107	film:tmdb:617706	75	75	0	-	985	15089	13	budget
141	film:tmdb:617706	film:tmdb:623135	75	75	0	-	985	17150	13	budget
142	film:tmdb:623135	film:tmdb:629078	75	75	0	-	985	14444	13	budget
143	film:tmdb:629078	film:tmdb:63583	75	75	0	-	985	15546	13	budget
144	film:tmdb:63583	film:tmdb:641	75	75	0	-	985	14320	13	budget
145	film:tmdb:641	film:tmdb:6466	75	75	0	-	985	17428	13	budget
146	film:tmdb:6466	film:tmdb:6519	75	74	1	film:tmdb:649409	985	16668	13	budget
147	film:tmdb:6519	film:tmdb:660001	75	75	0	-	985	15374	13	budget
148	film:tmdb:660001	film:tmdb:669664	75	75	0	-	985	15958	13	budget
149	film:tmdb:669664	film:tmdb:680493	75	75	0	-	985	15512	13	budget
150	film:tmdb:680493	film:tmdb:692442	75	75	0	-	985	14505	13	budget
151	film:tmdb:692442	film:tmdb:701387	75	75	0	-	985	14360	13	budget
152	film:tmdb:701387	film:tmdb:713177	75	75	0	-	985	16059	13	budget
153	film:tmdb:713177	film:tmdb:7229	75	75	0	-	985	14754	13	budget
154	film:tmdb:7229	film:tmdb:73108	75	75	0	-	985	15390	13	budget
155	film:tmdb:73108	film:tmdb:742056	75	75	0	-	985	16936	13	budget
156	film:tmdb:742056	film:tmdb:74998	75	75	0	-	985	15699	13	budget
157	film:tmdb:74998	film:tmdb:758330	75	75	0	-	985	15795	13	budget
158	film:tmdb:758330	film:tmdb:76493	75	75	0	-	985	15466	13	budget
159	film:tmdb:76493	film:tmdb:774301	75	75	0	-	985	14843	13	budget
160	film:tmdb:774301	film:tmdb:783556	75	75	0	-	985	15083	13	budget
161	film:tmdb:783556	film:tmdb:794234	75	75	0	-	985	15357	13	budget
162	film:tmdb:794234	film:tmdb:802217	75	75	0	-	985	15329	13	budget
163	film:tmdb:802217	film:tmdb:809102	75	75	0	-	985	15131	13	budget
164	film:tmdb:809102	film:tmdb:81900	75	75	0	-	985	15499	13	budget
165	film:tmdb:81900	film:tmdb:8273	75	75	0	-	985	16788	13	budget
166	film:tmdb:8273	film:tmdb:83459	75	75	0	-	985	17084	13	budget
167	film:tmdb:83459	film:tmdb:843	75	75	0	-	985	14744	13	budget
168	film:tmdb:843	film:tmdb:85199	75	75	0	-	985	16887	13	budget
169	film:tmdb:85199	film:tmdb:862553	75	75	0	-	985	14923	13	budget
170	film:tmdb:862553	film:tmdb:871799	75	75	0	-	985	17150	13	budget
171	film:tmdb:871799	film:tmdb:8835	75	75	0	-	985	15264	13	budget
172	film:tmdb:8835	film:tmdb:892268	75	75	0	-	985	15465	13	budget
173	film:tmdb:892268	film:tmdb:898994	75	75	0	-	985	15482	13	budget
174	film:tmdb:898994	film:tmdb:911	75	75	0	-	985	17320	13	budget
175	film:tmdb:911	film:tmdb:926	75	75	0	-	985	14537	13	budget
176	film:tmdb:926	film:tmdb:931438	75	75	0	-	985	15029	13	budget
177	film:tmdb:931438	film:tmdb:93856	75	75	0	-	985	15092	13	budget
178	film:tmdb:93856	film:tmdb:9455	75	75	0	-	985	14834	13	budget
179	film:tmdb:9455	film:tmdb:953542	75	75	0	-	985	14870	13	budget
180	film:tmdb:953542	film:tmdb:9612	75	75	0	-	985	15234	13	budget
181	film:tmdb:9612	film:tmdb:9703	75	75	0	-	985	15573	13	budget
182	film:tmdb:9703	film:tmdb:977294	75	75	0	-	985	14333	13	budget
183	film:tmdb:977294	film:tmdb:9838	75	75	0	-	985	16839	13	budget
184	film:tmdb:9838	film:tmdb:9932	75	75	0	-	985	15421	13	budget
185	film:tmdb:9932	film:zu4c	67	65	2	film:vCu0;film:xG0M	881	14226	13	end
```

### Independent count and terminal readbacks

- [Initial controller comment](https://trello.com/c/VJYgJuOW#comment-6b09ec393ed9b3edb21e821e), 20:46:49 UTC: first MCP range from empty input to `film:1XoW`, 75 examined, 74 noop, one stale, 988 queries, 16,964 ms, stable pins, `reachedEnd: false`; read-only D1 `SELECT COUNT(*) AS n FROM film` returned 13,867 and `SELECT COUNT(*) AS n FROM film WHERE id > 'film:1XoW'` returned 13,792 (both `rows_written: 0`).
- [Final controller comment](https://trello.com/c/VJYgJuOW#comment-6b09fb391d7d79939a1c8481), approximately 21:50 UTC: invocation 185 started after `film:tmdb:9932`, returned `film:zu4c`, 67 examined, 65 noop, two stale (`film:vCu0`, `film:xG0M`), 881 queries, 14,226 ms, `reachedEnd: true`. Read-only D1 `SELECT COUNT(*) AS n FROM film` returned 13,867; `SELECT COUNT(*) AS n FROM film WHERE id > 'film:zu4c'` returned 0; `SELECT version FROM schema_contract` returned 38. All three returned success and `rows_written: 0`. The owner-only `probe_read` returned ok, JWT verified, storage not accessed, side effects none at 21:49:41.331 UTC.

These readbacks establish agreement with the observed count and absence of a suffix at the final read; they do not establish a transaction-wide snapshot. The review does not require a new live scan.
