import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const LOAD =
  'new (require.call.call(require,null,"electron").BrowserWindow)({});';

it.each([
  "class C{method(){}}new C().method.call.call=other;",
  "class C{method=()=>{}}new C().method.call.call=other;",
  "class C{get method(){return ()=>{}}}new C().method.call.call=other;",
  "class C{static get method(){return ()=>{}}static set method(value){}}C.method.call.call=other;",
  "class C{static set method(value){}static get method(){return ()=>{}}}C.method.call.call=other;",
  "class C{get method(){return ()=>{}}set method(value){}}new C().method.call.call=other;",
  "class C{}const value=C.bind(null);value.call.call=other;",
  "class C{static get method(){return ()=>{}}}const value=C.method.bind(null);value.call.call=other;",
  "class B{}class C extends B{}const value=C.bind(null);value.call.call=other;",
  "function C(){return ()=>{}}new C().call.call=other;",
  "class C{method(){}static method={call:{}}}new C().method.call.call=other;",
  "class B{method=()=>{}}class C extends B{get method(){return {call:{}}}}new C().method.call.call=other;",
  "class B{method={call:{}}}class C extends B{method=()=>{}}new C().method.call.call=other;",
  "class C{constructor(){if(flag)return {method:{call:{}}}}method(){}}new C().method.call.call=other;",
])("retains shared helpers selected through class values: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(`${setup}${LOAD}`).electron.browser_windows,
  ).toEqual([]);
});

it.each([
  "class C{method(){}method={call:{}}}new C().method.call.call=other;",
  "class C{constructor(){return {method:{call:{}}}}method(){}}new C().method.call.call=other;",
  "class B{method={call:{}}}class C extends B{method(){}}new C().method.call.call=other;",
  "class B{method=()=>{}}class C extends B{method={call:{}}}new C().method.call.call=other;",
  "class B{static get method(){return ()=>{}}}class C extends B{static set method(value){}}C.method.call.call=other;",
  "class C{static bind(){return {call:{}}}}const value=C.bind(null);value.call.call=other;",
  "class C{static get method(){return {bind(){return {call:{}}}}}}const value=C.method.bind(null);value.call.call=other;",
  "class B{}class C extends B{}C.__proto__.call=other;",
  "function C(){}new C().call.call=other;",
])("keeps noncallable class slots separate: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(`${setup}${LOAD}`).electron.browser_windows,
  ).toHaveLength(1);
});
