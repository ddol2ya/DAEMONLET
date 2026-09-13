const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const output = process.env.INDEPENDENT_QA_OUTPUT
app.setPath('userData', path.join(output, 'profile'))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1320, height: 1320, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(`(async()=>{${code}})()`, true)
  const q = JSON.stringify
  try {
    await win.loadURL(process.env.INDEPENDENT_QA_URL + '/independent-model-qa')
    const models = await run(`window.qa = await import('/scripts/characters/verify-independent-browser.mjs'); return (await(await fetch(${q(process.env.INDEPENDENT_QA_SOURCE+'/models.json')})).json()).models`)
    if (!models.length) throw new Error('No selected models to verify')
    const results = []
    for (const model of models) {
      const report = await run(`return qa.comparePose(${q(process.env.INDEPENDENT_QA_SOURCE)},${q(process.env.INDEPENDENT_QA_ID)},${q(model)})`)
      const directory = path.join(output, model.id); fs.mkdirSync(directory, { recursive: true })
      for (const [name, png] of Object.entries(report.screenshots)) fs.writeFileSync(path.join(directory, name+'.png'), Buffer.from(png.split(',')[1], 'base64'))
      delete report.screenshots
      fs.writeFileSync(path.join(directory, 'comparison.json'), JSON.stringify(report, null, 2)+'\n')
      results.push(report)
      console.log(JSON.stringify({pose:model.id,status:report.status,staticCases:report.cases.length,customFrames:report.customFrames,vertexError:report.maxVertexDifference,maxMeanError:Math.max(...report.cases.map(test=>test.meanRgbaError))}))
      if (report.status !== 'passed') throw new Error('Independent rendering differs from selected model: '+model.id)
    }
    const compositor = await run(`return qa.checkModelCrossfade(${q(results[0].sourceAnchors)})`)
    fs.writeFileSync(path.join(output, 'model-compositor.json'), JSON.stringify(compositor, null, 2)+'\n')
    fs.writeFileSync(path.join(output, 'render-verification.json'), JSON.stringify({status:'passed',models:results.length,staticCases:results.reduce((sum,result)=>sum+result.cases.length,0),customFrames:results.reduce((sum,result)=>sum+result.customFrames,0),maxVertexDifference:Math.max(...results.map(result=>result.maxVertexDifference)),compositor:compositor.status}, null, 2)+'\n')
    console.log('Independent model renderer verification passed')
  } catch (error) { console.error(error); fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error.stack||error)},null,2));process.exitCode=1 }
  finally { win.destroy(); app.exit(process.exitCode || 0) }
}).catch(error => { console.error(error); app.exit(1) })
