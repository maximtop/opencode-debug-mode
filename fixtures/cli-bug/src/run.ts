import { discount } from "./discount.js"

const result = discount("vip-42")
console.log(JSON.stringify({ result }))
if (result !== 20) process.exitCode = 1
