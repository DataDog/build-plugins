// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Import triggers the transform hook, replacing the backend file with an RPC proxy.
import './greet.backend.js';

console.log('Hello from apps plugin, {{bundler}}!');
