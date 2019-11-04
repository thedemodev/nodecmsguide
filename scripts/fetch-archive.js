import path from 'path'
import fs from 'fs-extra'
import { map, find, fromPairs, mapValues } from 'lodash'
import { differenceInMinutes, differenceInDays } from 'date-fns'
import Octokit from '@octokit/rest'
import twitterFollowersCount from 'twitter-followers-count'

require(`dotenv`).config({
  path: `.env.${process.env.NODE_ENV}`,
})

const GITHUB_TOKEN = process.env.HEADLESS_CMS_GITHUB_TOKEN
const TWITTER_CONSUMER_KEY = process.env.HEADLESS_CMS_TWITTER_CONSUMER_KEY
const TWITTER_CONSUMER_SECRET = process.env.HEADLESS_CMS_TWITTER_CONSUMER_SECRET
const TWITTER_ACCESS_TOKEN_KEY = process.env.HEADLESS_CMS_TWITTER_ACCESS_TOKEN_KEY
const TWITTER_ACCESS_TOKEN_SECRET = process.env.HEADLESS_CMS_TWITTER_ACCESS_TOKEN_SECRET
const ARCHIVE_FILENAME = 'headless-cms-archive.json'
const LOCAL_ARCHIVE_PATH = `tmp/${ARCHIVE_FILENAME}`
const GIST_ARCHIVE_DESCRIPTION = 'NODECMS.GUIDE DATA ARCHIVE'

let octokit
let getTwitterFollowers

function authenticate() {
  octokit = Octokit()
  octokit.authenticate({ type: 'token', token: GITHUB_TOKEN })
  getTwitterFollowers = twitterFollowersCount({
    consumer_key: TWITTER_CONSUMER_KEY,
    consumer_secret: TWITTER_CONSUMER_SECRET,
    access_token_key: TWITTER_ACCESS_TOKEN_KEY,
    access_token_secret: TWITTER_ACCESS_TOKEN_SECRET,
  })
}

async function getProjectGitHubData(repo) {
  const [owner, repoName] = repo.split('/')
  const { data } = await octokit.repos.get({ owner, repo: repoName })
  const { stargazers_count, forks_count, open_issues_count } = data
  return { stars: stargazers_count, forks: forks_count, issues: open_issues_count }
}

async function getAllProjectGitHubData(repos) {
  const data = await Promise.all(repos.map(async repo => {
    const repoData = await getProjectGitHubData(repo)
    return [repo, repoData]
  }))
  return fromPairs(data)
}

async function getAllProjectData(projects) {
  const timestamp = Date.now()
  const twitterScreenNames = map(projects, 'twitter').filter(val => val)
  const twitterFollowers = await getTwitterFollowers(twitterScreenNames)
  const gitHubRepos = map(projects, 'repo').filter(val => val)
  const gitHubReposData = await getAllProjectGitHubData(gitHubRepos)
  const data = projects.reduce((obj, { slug, repo, twitter }) => {
    const twitterData = twitter ? { followers: twitterFollowers[twitter] } : {}
    const gitHubData = repo ? { ...(gitHubReposData[repo]) } : {}
    return { ...obj, [slug]: [{ timestamp, ...twitterData, ...gitHubData }] }
  }, {})
  return { timestamp, data }
}

async function getLocalArchive() {
  try {
    return await fs.readJson(path.join(process.cwd(), LOCAL_ARCHIVE_PATH))
  } catch (e) {
    console.log('Local archive not found, fetching new data.')
  }
}

function updateLocalArchive(data) {
  return fs.outputJson(path.join(process.cwd(), LOCAL_ARCHIVE_PATH), data)
}


async function getArchive() {
  const gists = await octokit.gists.getAll({ per_page: 100 })
  const gistArchive = find(gists.data, { description: GIST_ARCHIVE_DESCRIPTION })
  if (!gistArchive) {
    return
  }
  const gistArchiveContent = await octokit.gists.get({ id: gistArchive.id })
  const archive = JSON.parse(gistArchiveContent.data.files[ARCHIVE_FILENAME].content)
  return { ...archive, id: gistArchive.id }
}

function createGist(content) {
  return octokit.gists.create({
    files: { [ARCHIVE_FILENAME]: { content } },
    public: true,
    description: GIST_ARCHIVE_DESCRIPTION,
  })
}

function editGist(content, id) {
  return octokit.gists.edit({ id, files: { [ARCHIVE_FILENAME]: { content } } })
}

function removeOutdated(data, days) {
  return data.filter(({ timestamp }) => differenceInDays(Date.now(), timestamp) <= days)
}

async function updateArchive({ timestamp, data }, archive) {
  const preppedData = archive
    ? {
      timestamp,
      data: mapValues(data, (projectData, name) => {
        const projectArchive = removeOutdated(archive.data[name] || [], 30)
        return [...projectData, ...projectArchive]
      }),
    }
    : { timestamp, data }
  const content = JSON.stringify(preppedData)
  if (archive) {
    await editGist(content, archive.id)
  } else {
    await createGist(content)
  }
  return preppedData
}

/**
 * Check if archive is expired. Currently set to 1410 minutes, which is 30
 * minutes short of 24 hours, just in case a daily refresh webhook gets called
 * a little early.
 */
function archiveExpired(archive) {
  return differenceInMinutes(Date.now(), archive.timestamp) > 1410
}

async function run(projects) {
  const localArchive = await getLocalArchive()
  if (localArchive && !archiveExpired(localArchive)) {
    return localArchive.data
  }

  // This is synchronous.
  authenticate()

  const archive = await getArchive()
  if (archive && !archiveExpired(archive)) {
    await updateLocalArchive(archive)
    return archive.data
  }

  const projectData = await getAllProjectData(projects)
  const updatedArchive = await updateArchive(projectData, archive)
  await updateLocalArchive(updatedArchive)
  return updatedArchive.data
}

export default run
