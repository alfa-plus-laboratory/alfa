/**
 * Small runnable projects whose acceptance tests are independent of the agent. Each first
 * proves the bug exists, so a successful exit can't pass itself off as a finished task.
 * Changed conventions must be explicit in the prompt: pagination starts zero-based in
 * the fixture, but its target contract is one-based. Leaving that unstated penalized
 * correct preservation of existing behavior instead of measuring the requested change.
 */
export interface Task { id: string; prompt: string; files: Record<string, string>; acceptance: string; oracle: Record<string, string> }
export const tasks: Task[] = [
  {
    id: "csv-quotes",
    prompt: "Fix parseCSV in csv.ts. Support quoted commas, escaped double quotes, CRLF, and embedded newlines in quoted fields. Preserve empty fields. Add regression tests and run bun test. Keep the exported function signature.",
    files: { "csv.ts": 'export function parseCSV(text: string): string[][] { return text.trim().split("\\n").map(line => line.split(",")) }\n', "csv.test.ts": 'import {test,expect} from "bun:test"; import {parseCSV} from "./csv"; test("basic",()=>expect(parseCSV("a,b")).toEqual([["a","b"]]));' },
    acceptance: 'import {test,expect} from "bun:test"; import {parseCSV} from "./csv"; test("quoted fields",()=>{expect(parseCSV(\'name,note\\r\\nA,"a,b"\\r\\nB,"say ""yes"""\')).toEqual([["name","note"],["A","a,b"],["B",\'say "yes"\']]);expect(parseCSV(\'"a\\nb",,\')).toEqual([["a\\nb","",""]]);});',
    oracle: { "csv.ts": `export function parseCSV(text: string): string[][] {
 const rows: string[][] = []; let row: string[] = [], field = "", quoted = false;
 for (let i=0;i<text.length;i++) { const c=text[i]!;
 if(c==='"') {if(quoted && text[i+1]==='"'){field+='"';i++}else quoted=!quoted}
 else if(!quoted && c===','){row.push(field);field=""}
 else if(!quoted && (c==='\\n'||c==='\\r')){if(c==='\\r'&&text[i+1]==='\\n')i++;row.push(field);rows.push(row);row=[];field=""}
 else field+=c;
 } if(field||row.length||(!rows.length && text.length)){row.push(field);rows.push(row)} return rows;
}` },
  },
  {
    id: "pagination",
    prompt: "Fix the pagination API in packages/core/page.ts and adapt packages/app/view.ts. Reject nonpositive/noninteger page sizes. Page numbers are one-based: n=1 selects the first page; clamp values below 1 to the first page and values above the last page to the last page. Return items plus totalPages, keep the app's renderPage returning a comma-separated string. Add tests and run bun test.",
    files: { "packages/core/page.ts": 'export function page<T>(items:T[], n:number, size:number):T[]{return items.slice(n*size,n*size+size)}', "packages/app/view.ts": 'import {page} from "../core/page"; export function renderPage(items:string[],n:number,size:number){return page(items,n,size).join(",")}', "page.test.ts": 'import {test,expect} from "bun:test"; import {renderPage} from "./packages/app/view"; test("result is text",()=>expect(typeof renderPage(["a"],1,10)).toBe("string"));' },
    acceptance: 'import {test,expect} from "bun:test"; import {page} from "./packages/core/page"; import {renderPage} from "./packages/app/view"; test("page contract",()=>{expect(page([1,2,3],1,2)).toEqual({items:[1,2],totalPages:2});expect(page([1,2,3],99,2)).toEqual({items:[3],totalPages:2});expect(page([1,2],0,1)).toEqual({items:[1],totalPages:2});expect(()=>page([],1,0)).toThrow();expect(()=>page([],1,1.5)).toThrow();expect(renderPage(["a","b","c"],1,2)).toBe("a,b");});',
    oracle: { "packages/core/page.ts": 'export function page<T>(items:T[],n:number,size:number){if(!Number.isInteger(size)||size<=0)throw new Error("Invalid size");const totalPages=Math.ceil(items.length/size);const at=Math.max(1,Math.min(Math.floor(n)||1,Math.max(1,totalPages)));return {items:items.slice((at-1)*size,at*size),totalPages}}', "packages/app/view.ts": 'import {page} from "../core/page"; export function renderPage(items:string[],n:number,size:number){return page(items,n,size).items.join(",")}' },
  },
  {
    id: "retry-cancel",
    prompt: "Fix retry.ts: retry(fn, attempts, signal) must stop after attempts total calls, propagate the final error, return success immediately and never call fn if already aborted. Treat attempts <= 0 as invalid. Add regression tests and run bun test.",
    files: { "retry.ts": 'export async function retry<T>(fn:()=>Promise<T>, attempts:number, signal?:AbortSignal):Promise<T>{for(let i=0;i<=attempts;i++){try{return await fn()}catch{}}return undefined as T}', "retry.test.ts": 'import {test,expect} from "bun:test"; import {retry} from "./retry"; test("success",async()=>expect(await retry(async()=>42,2)).toBe(42));' },
    acceptance: 'import {test,expect} from "bun:test"; import {retry} from "./retry"; test("limits and abort",async()=>{let calls=0;const e=new Error("last");await expect(retry(async()=>{calls++;throw e},2)).rejects.toBe(e);expect(calls).toBe(2);const c=new AbortController();c.abort();await expect(retry(async()=>{calls++;return 1},2,c.signal)).rejects.toThrow();expect(calls).toBe(2);await expect(retry(async()=>1,0)).rejects.toThrow();});',
    oracle: { "retry.ts": 'export async function retry<T>(fn:()=>Promise<T>,attempts:number,signal?:AbortSignal):Promise<T>{if(!Number.isInteger(attempts)||attempts<=0)throw new Error("Invalid attempts");for(let i=0;i<attempts;i++){signal?.throwIfAborted();try{return await fn()}catch(e){if(i===attempts-1)throw e}}throw new Error("Unreachable")}' },
  },
]
