// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Imports two inputs through the public barrel but only uses one of them
// (datadogServicePanel is imported and never referenced).
import { datadogServicePanel, datadogTheme } from '@datadog/apps-frontend/inputs/schema';

document.body.dataset.input = datadogTheme.identifier;

// The dashboard input is only used from a lazily loaded chunk.
import('./dashboard-view.js').then(({ renderDashboardView }) => renderDashboardView());
