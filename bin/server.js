const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')
const debug = require('debug')('express-git-manage')
const express = require('express')
const fs = require('fs')
const path = require('path')
const { prepareMustacheOverlays, setupErrorHandlers } = require('express-mustache-overlays')
const shell = require('shelljs')
const { setupMiddleware } = require('express-mustache-jwt-signin')
const { promisify } = require('util')
const mustache = require('mustache')
const git = require('nodegit')
const mime = require('mime-types')

const lstatAsync = promisify(fs.lstat)

const port = process.env.PORT || 80
const scriptName = process.env.SCRIPT_NAME || ''
if (scriptName.endsWith('/')) {
  throw new Error('SCRIPT_NAME should not end with /.')
}
const reposDir = process.env.DIR
if (!reposDir) {
  throw new Error('No DIR environment variable set to specify the path of the repo.')
}
const secret = process.env.SECRET
const gitDomain = process.env.GIT_DOMAIN || 'git.example.com'
const signInURL = process.env.SIGN_IN_URL || '/user/signin'
const signOutURL = process.env.SIGN_OUT_URL || '/user/signout'
const disableAuth = ((process.env.DISABLE_AUTH || 'false').toLowerCase() === 'true')
if (!disableAuth) {
  if (!secret || secret.length < 8) {
    throw new Error('No SECRET environment variable set, or the SECRET is too short. Need 8 characters')
  }
  if (!signInURL) {
    throw new Error('No SIGN_IN_URL environment variable set')
  }
} else {
  debug('Disabled auth')
}
const mustacheDirs = process.env.MUSTACHE_DIRS ? process.env.MUSTACHE_DIRS.split(':') : []
const publicFilesDirs = process.env.PUBLIC_FILES_DIRS ? process.env.PUBLIC_FILES_DIRS.split(':') : []
const publicURLPath = process.env.PUBLIC_URL_PATH || scriptName + '/public'
const listTitle = process.env.LIST_TITLE || 'Git Repos'
const createTitle = process.env.CREATE_TITLE || 'Create'

const main = async () => {
  const app = express()
  app.use(cookieParser())

  const overlays = await prepareMustacheOverlays(app, { scriptName, publicURLPath })

  app.use((req, res, next) => {
    debug('Setting up locals')
    res.locals = Object.assign({}, res.locals, { publicURLPath, scriptName, title: 'Express Git Manage', signOutURL: signOutURL, signInURL: signInURL })
    next()
  })

  let { signedIn, withUser, hasClaims } = await setupMiddleware(app, secret, { overlays, signOutURL, signInURL })
  if (disableAuth) {
    signedIn = function (req, res, next) {
      debug(`signedIn disabled by DISBABLE_AUTH='true'`)
      next()
    }
    hasClaims = function () {
      return function (req, res, next) {
        debug(`hasClaims disabled by DISBABLE_AUTH='true'`)
        next()
      }
    }
  } else {
    app.use(withUser)
  }

  overlays.overlayMustacheDir(path.join(__dirname, '..', 'views'))
  overlays.overlayPublicFilesDir(path.join(__dirname, '..', 'public'))

  // Set up any other overlays directories here
  mustacheDirs.forEach(dir => {
    debug('Adding mustache dir', dir)
    overlays.overlayMustacheDir(dir)
  })
  publicFilesDirs.forEach(dir => {
    debug('Adding publicFiles dir', dir)
    overlays.overlayPublicFilesDir(dir)
  })

  app.use(bodyParser.urlencoded({ extended: true }))
  app.get(scriptName, signedIn, async (req, res, next) => {
    try {
      debug('Edit / handler')
      const ls = shell.ls(reposDir)
      if (shell.error()) {
        throw new Error('Could not list ' + reposDir)
      }
      const repos = []
      for (let filename of ls) {
        const stat = await lstatAsync(path.join(reposDir, filename))
        if (stat.isDirectory()) {
          repos.push({ name: filename, url: scriptName + '/repo/' + encodeURIComponent(filename) })
        }
      }
      res.render('list', { title: listTitle, repos })
    } catch (e) {
      debug(e)
      next(e)
    }
  })

  app.get(scriptName + '/repo/:repo', signedIn, async (req, res, next) => {
    try {
      const repo = req.params.repo
      const gitrepo = await git.Repository.open(path.join(reposDir, repo))
      const arrayString = await gitrepo.getReferenceNames(git.Reference.TYPE.LISTALL)
      debug(arrayString)
      const branches = []
      for (let ref of arrayString) {
        debug(ref)
        branches.push({ name: ref, link: scriptName + '/repo/' + repo + '/branch/' + ref.slice(11, ref.length) + '/' })
      }
      res.render('branches', { repo, branches, title: 'Branches' })
    } catch (e) {
      debug(e)
      next(e)
    }
  })

  app.get(scriptName + '/repo/:repo/branch/:branch/commit/:commit/file/*', signedIn, async (req, res, next) => {
    try {
      const repo = req.params.repo
      const branch = req.params.branch
      const commit = req.params.commit
      const file = req.params[0]

      const contentType = mime.lookup(file)

      const gitrepo = await git.Repository.open(path.join(reposDir, repo))
      const commitObj = await gitrepo.getCommit(commit)
      const entry = await commitObj.getEntry(file)
      const blob = await entry.getBlob()
      const buffer = blob.content()

      debug(repo, branch, commit, file, contentType, buffer)
      if (contentType) {
        res.type(contentType)
      } else {
        res.type('application/octet-stream')
      }
      res.status(200)
      res.end(buffer)
    } catch (e) {
      debug(e)
      next(e)
    }
  })

  app.get(scriptName + '/repo/:repo/branch/:branch/commit/:commit/*', signedIn, async (req, res, next) => {
    try {
      const repo = req.params.repo
      const branch = req.params.branch
      const commit = req.params.commit

      debug(repo, branch, commit)

      const gitrepo = await git.Repository.open(path.join(reposDir, repo))
      const commitObj = await gitrepo.getBranchCommit(branch)
      const tree = await commitObj.getTree()

      const files = []
      const walker = tree.walk()
      walker.on('entry', function (entry) {
        files.push({ name: entry.path(), link: scriptName + '/repo/' + repo + '/branch/' + branch + '/commit/' + commit + '/file/' + entry.path()
        })
        // files.push({name: 'ada', link: scriptName + '/repo/' + repo+ '/branch/' + ref.slice(11, ref.length)})
      })

      walker.on('end', function(trees) {
        res.render('files', { repo, branch, commit, files, title: 'Files' })
      })

      walker.on('error', function(error) {
        debug(error)
      });
      walker.start()
    } catch (e) {
      debug(e)
      next(e)
    }
  })

  app.get(scriptName + '/repo/:repo/branch/:branch/*', signedIn, async (req, res, next) => {
    try {
      const repo = req.params.repo
      const branch = req.params.branch

      const gitrepo = await git.Repository.open(path.join(reposDir, repo))
      const commit = await gitrepo.getBranchCommit(branch)
      debug({ commit })

      const commits = []
      const history = commit.history()
      // Create a counter to only show up to 9 entries.
      let count = 0
      // Listen for commit events from the history.
      history.on('commit', function (commit) {
        const c = {}
        // Disregard commits past 9.
        if (++count >= 9) {
          return
        }
        // Show the commit sha.
        c.sha = commit.sha()
        // Store the author object.
        let author = commit.author()
        // Display author information.
        c.name = author.name()
        c.email = author.email()
        // Show the commit date.
        c.date = commit.date()
        c.message = commit.message()
        c.link = scriptName + '/repo/' + repo + '/branch/' + branch + '/commit/' + c.sha + '/'
        commits.push(c)
      })
      history.on('end', function (commits_) {
        debug(commits)
        res.render('commits', { repo, commits, title: 'Commits', branch })
      })
      history.on('error', function (e) {
        debug(e)
      })
      history.start()
    } catch (e) {
      debug(e)
      next(e)
    }
  })

  // app.all(scriptName + '/throw', signedIn, hasClaims(claims => claims.admin), async (req, res, next) => {
  //   try {
  //     throw new Error('test')
  //   } catch (e) {
  //     next(e)
  //     return
  //   }
  // })

  app.post(scriptName + '/create', signedIn, hasClaims(claims => claims.admin), async (req, res, next) => {
    try {
      debug('Create handler')
      const name = req.body.name
      debug(reposDir, name)
      const repoPath = path.join(reposDir, name)
      const expected = path.normalize(reposDir)
      if (!path.normalize(repoPath).startsWith(expected + '/')) {
        throw new Error('Requested directory is not in the repo directory: ' + repoPath)
      }
      debug(repoPath)
      try {
        const gitrepo = await git.Repository.init(repoPath, 1)
        // shell.exec('git init --bare "' + repoPath + '"')
        // if (shell.error()) {
        //   throw new Error(`Could not create git repo for ${repoPath}.`)
        // }
      } catch (e) {
        debug(e.toString())
        res.render('content', { title: createTitle, content: '<h1>Error</h1><p>Could not create repo.</p>' })
        return
      }
      res.render('created', { title: createTitle, repo: name, gitDomain})
      // , content: '<h1>Success</h1><p>Repo created. <a href="' + mustache.escape(scriptName + '/repo/' + name) + '">List branches.</a></p>' })
    } catch (e) {
      debug(e)
      next(e)
    }
  })

  overlays.setup()

  setupErrorHandlers(app)

  app.listen(port, () => console.log(`Example app listening on port ${port}`))
}

main()

// Better handling of SIGNIN for docker
process.on('SIGINT', function () {
  console.log('Exiting ...')
  process.exit()
})
