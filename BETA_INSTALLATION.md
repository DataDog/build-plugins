# Welcome to the beta <!-- omit in toc -->

Thank you so much for joining the beta!

If you want to join the beta, [**ping us**](mailto:yoann+build-beta@datadog.com?subject=I%27d%20love%20to%20join%20the%20beta%20of%20build-plugin%21).

## Table of content <!-- omit in toc -->
<details>
<summary>Click to expand</summary>

- [**Github token**](#github-token)
- [**Install with the token**](#install-with-the-token)
  - [via config files](#via-config-files)
    - [**.npmrc**](#npmrc)
    - [**.yarnrc.yml**](#yarnrcyml)
    - [Install](#install)
  - [via CLI](#via-cli)
    - [**For NPM**](#for-npm)
    - [**For Yarn v1**](#for-yarn-v1)
    - [**For Yarn v2**](#for-yarn-v2)

</details>

## **Github token**

You'll need [a personal github token](https://github.com/settings/tokens/new).

![Github Token](./assets/github-token.png)

## **Install with the token**

### via config files

#### **.npmrc**

Will work with **NPM** and **Yarn v1**

```
//npm.pkg.github.com/:_authToken={{GH_TOKEN}}
@datadog:registry=https://npm.pkg.github.com
```

📝 Replace with your `GH_TOKEN`

#### **.yarnrc.yml**

Will work with **Yarn v2**

```yaml
npmScopes:
  datadog:
    npmAuthToken: {{TOKEN}}
    npmRegistryServer: "https://npm.pkg.github.com"
```

📝 Replace with your `GH_TOKEN`

#### Install

Then run the install command.

```bash
# NPM
npm install --save-dev @datadog/build-plugin

# Yarn
yarn add -D @datadog/build-plugin
```

### via CLI

Add your token to your environment.

```bash
export GH_TOKEN=token
```

📝 Replace with your `token`

#### **For NPM**

.npmrc

```
@datadog:registry=https://npm.pkg.github.com
```

Install command

```bash
NODE_AUTH_TOKEN=$GH_TOKEN npm install --save-dev @datadog/build-plugin
```

#### **For Yarn v1**

.npmrc

```
@datadog:registry=https://npm.pkg.github.com
```

Install command

```bash
NODE_AUTH_TOKEN=$GH_TOKEN yarn add -D @datadog/build-plugin
```

#### **For Yarn v2**

.yarnrc.yml

```yaml
npmScopes:
  datadog:
    npmRegistryServer: "https://npm.pkg.github.com"
```

Install command

```bash
YARN_NPM_AUTH_TOKEN=$GH_TOKEN yarn add -D @datadog/build-plugin
```
